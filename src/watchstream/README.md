# Watched streams

This directory owns the application feature for watching another Discord call
participant's stream.

## Boundary

- `service.ts` owns stream discovery, target resolution, the single active watch,
  user feedback, and routing app-gateway stream events.
- `controller.ts` owns the watched stream RTC connection and recovery state machine.
- `playback.ts` forwards received H.264/Opus RTP to `mpv` or `ffplay`.
- `keys.ts` owns Discord stream-key parsing and matching.
- `voice-member-action.ts` owns synchronization of the Watch Stream menu action.

The feature deliberately depends on two shared transports rather than duplicating
them: `appgateway.ts` supplies Discord's stream signaling events and `voice/`
supplies the reusable receive-only WebRTC connection. `session.ts` only constructs
the service, supplies app-state lookups, and forwards those shared transport events.
