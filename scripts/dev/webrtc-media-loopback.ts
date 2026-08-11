#!/usr/bin/env bun
/**
 * Local-only node-datachannel RTP media smoke test.
 *
 * Verifies that Record's packetizer/Track.sendMessageBinary setup can move an
 * encoded H.264 access unit between two in-process PeerConnections. It never
 * connects to Discord.
 */
import {
  H264RtpPacketizer,
  PacingHandler,
  PeerConnection,
  RtcpNackResponder,
  RtcpSrReporter,
  RtpPacketizationConfig,
  Video,
  type Track,
} from "@lng2004/node-datachannel";

const VIDEO_PAYLOAD_TYPE = 103;
const VIDEO_SSRC = 424_242;
const timeoutMs = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sender = new PeerConnection("record-loopback-sender", { iceServers: [] });
const receiver = new PeerConnection("record-loopback-receiver", { iceServers: [] });
let senderTrack: Track | null = null;
let receiverTrack: Track | null = null;
let receivedPackets = 0;

sender.onLocalCandidate((candidate, mid) => receiver.addRemoteCandidate(candidate, mid));
receiver.onLocalCandidate((candidate, mid) => sender.addRemoteCandidate(candidate, mid));
sender.onStateChange((state) => console.log(JSON.stringify({ peer: "sender", state })));
receiver.onStateChange((state) => console.log(JSON.stringify({ peer: "receiver", state })));
receiver.onTrack((track) => {
  receiverTrack = track;
  console.log(JSON.stringify({ event: "receiver_track", mid: track.mid(), type: track.type(), direction: track.direction() }));
  track.onMessage((message) => {
    const packet = Buffer.isBuffer(message) ? message : Buffer.from(message);
    receivedPackets += 1;
    console.log(JSON.stringify({ event: "rtp", bytes: packet.length, payloadType: packet.length > 1 ? packet[1]! & 0x7f : null }));
  });
});

sender.onLocalDescription((sdp, type) => {
  console.log(JSON.stringify({ peer: "sender", event: "local_description", type }));
  // Auto-negotiation generates the receiver's answer after the offer is set.
  receiver.setRemoteDescription(sdp, type);
});
receiver.onLocalDescription((sdp, type) => {
  console.log(JSON.stringify({ peer: "receiver", event: "local_description", type }));
  sender.setRemoteDescription(sdp, type);
});

const video = new Video("1", "SendOnly");
video.addH264Codec(VIDEO_PAYLOAD_TYPE);
senderTrack = sender.addTrack(video);
const config = new RtpPacketizationConfig(VIDEO_SSRC, "record-loopback", VIDEO_PAYLOAD_TYPE, 90_000);
const packetizer = new H264RtpPacketizer("StartSequence", config);
packetizer.addToChain(new RtcpSrReporter(config));
packetizer.addToChain(new RtcpNackResponder());
packetizer.addToChain(new PacingHandler(25 * 1000 * 1000, 1));
senderTrack.setMediaHandler(packetizer);
senderTrack.onOpen(() => console.log(JSON.stringify({ peer: "sender", event: "track_open", direction: senderTrack?.direction() })));
senderTrack.onError((error) => console.log(JSON.stringify({ peer: "sender", event: "track_error", error })));
sender.setLocalDescription("offer");

const deadline = Date.now() + timeoutMs;
while ((sender.state() !== "connected" || receiver.state() !== "connected" || !senderTrack.isOpen() || !receiverTrack?.isOpen()) && Date.now() < deadline) {
  await sleep(25);
}
if (sender.state() !== "connected" || receiver.state() !== "connected") throw new Error("Loopback PeerConnections did not connect.");

// A small Annex-B IDR access unit. The smoke test validates RTP packetization
// and transport, not H.264 decoding.
const accessUnit = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21, 0xa0]);
const sent = senderTrack.sendMessageBinary(accessUnit);
console.log(JSON.stringify({ event: "send", sent, direction: senderTrack.direction(), open: senderTrack.isOpen(), bytes: accessUnit.length }));

const receiveDeadline = Date.now() + 2_000;
while (receivedPackets === 0 && Date.now() < receiveDeadline) await sleep(25);
// PacingHandler owns the frame asynchronously, so node-datachannel may return
// false even though it successfully emits RTP. Delivery is the useful result.
const ok = receivedPackets > 0;
console.log(JSON.stringify({ event: "done", receivedPackets, ok }));

sender.close();
receiver.close();
process.exit(ok ? 0 : 1);
