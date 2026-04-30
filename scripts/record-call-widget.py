#!/usr/bin/env python3
"""Small X11/GTK overlay for Record voice-call participants.

The process reads JSON-lines on stdin:
  {"type":"update","participants":[{"id":"...","name":"...","avatarUrl":"...","speaking":false,"self":true}]}
  {"type":"close"}

It intentionally has no Discord knowledge; Record owns participant/speaking state.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import sys
import threading
import urllib.request
import warnings
from pathlib import Path
from typing import Any

try:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("GdkPixbuf", "2.0")
    gi.require_version("Pango", "1.0")
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    from gi.repository import Gdk, GLib, Gtk, Pango
except Exception as exc:  # pragma: no cover - surfaced in Record debug log via stderr
    print(f"record-call-widget: failed to import GTK: {exc}", file=sys.stderr, flush=True)
    raise

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:
    Image = None
    ImageDraw = None
    ImageFont = None

AVATAR_SIZE = 58
BORDER_WIDTH = 5
CARD_PADDING = 12
ROW_PADDING_X = 8
ROW_PADDING_Y = 6
NAME_GAP = 12
ROW_GAP = 8
NAME_WIDTH = 180
IDLE_ALPHA = 0.74
SPEAKING_ALPHA = 1.0
SPEAKING_BORDER = (0x23, 0xA5, 0x5A, 0xFF)
IDLE_BORDER = (0x30, 0x3A, 0x4A, 0xDD)
DEFAULT_NAME_COLOR = "#f8fafc"
PLACEHOLDER_BG = (0x1D, 0x9B, 0xF0, 0xFF)
PLACEHOLDER_FG = (0xF1, 0xFA, 0xEE, 0xFF)
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "record" / "call-widget"


class Participant:
    def __init__(self, data: dict[str, Any]):
        self.id = str(data.get("id") or "")
        self.name = str(data.get("name") or self.id or "?")
        self.avatar_url = data.get("avatarUrl") if isinstance(data.get("avatarUrl"), str) else None
        self.role_color = normalize_role_color(data.get("roleColor"))
        self.speaking = bool(data.get("speaking"))
        self.self = bool(data.get("self"))


def safe_cache_name(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "ignore")).hexdigest()[:32]


def initials(name: str) -> str:
    words = [part for part in name.replace("@", " ").split() if part]
    if not words:
        return "?"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][:1] + words[1][:1]).upper()


def normalize_role_color(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if len(value) != 7 or not value.startswith("#"):
        return None
    try:
        int(value[1:], 16)
    except ValueError:
        return None
    return value.lower()


def label_markup(participant: Participant) -> str:
    color = participant.role_color or DEFAULT_NAME_COLOR
    weight = "700" if participant.speaking else "500"
    escaped_name = html.escape(participant.name, quote=False)
    return f'<span foreground="{color}" weight="{weight}">{escaped_name}</span>'


def placeholder_path(participant: Participant) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"placeholder-{safe_cache_name(participant.id or participant.name)}.png"
    if path.exists():
        return path
    if Image is None or ImageDraw is None:
        return path

    image = Image.new("RGBA", (AVATAR_SIZE * 2, AVATAR_SIZE * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((0, 0, image.width - 1, image.height - 1), fill=PLACEHOLDER_BG)
    text = initials(participant.name)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 42) if ImageFont else None
    except Exception:
        font = ImageFont.load_default() if ImageFont else None
    bbox = draw.textbbox((0, 0), text, font=font)
    x = (image.width - (bbox[2] - bbox[0])) / 2 - bbox[0]
    y = (image.height - (bbox[3] - bbox[1])) / 2 - bbox[1] - 2
    draw.text((x, y), text, fill=PLACEHOLDER_FG, font=font)
    image.save(path)
    return path


def avatar_path(participant: Participant) -> Path:
    if participant.avatar_url:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        suffix = ".gif" if ".gif" in participant.avatar_url.split("?", 1)[0].lower() else ".png"
        path = CACHE_DIR / f"avatar-{safe_cache_name(participant.avatar_url)}{suffix}"
        if not path.exists():
            try:
                req = urllib.request.Request(participant.avatar_url, headers={"User-Agent": "record-call-widget/0.1"})
                with urllib.request.urlopen(req, timeout=8) as response:
                    path.write_bytes(response.read())
            except Exception as exc:
                print(f"record-call-widget: avatar fetch failed for {participant.id}: {exc}", file=sys.stderr, flush=True)
                return placeholder_path(participant)
        return path
    return placeholder_path(participant)


def render_avatar_path(participant: Participant) -> Path:
    key = json.dumps({
        "id": participant.id,
        "name": participant.name,
        "avatar": participant.avatar_url,
        "speaking": participant.speaking,
    }, sort_keys=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    output = CACHE_DIR / f"rendered-{safe_cache_name(key)}.png"
    if output.exists():
        return output
    source = avatar_path(participant)
    if Image is None or ImageDraw is None or not source.exists():
        return source

    diameter = AVATAR_SIZE + BORDER_WIDTH * 2
    try:
        avatar = Image.open(source).convert("RGBA")
    except Exception as exc:
        print(f"record-call-widget: avatar load failed for {participant.id}: {exc}", file=sys.stderr, flush=True)
        avatar = Image.open(placeholder_path(participant)).convert("RGBA")

    # Center-crop before resizing so rectangular avatars still fill the circle.
    side = min(avatar.width, avatar.height)
    left = (avatar.width - side) // 2
    top = (avatar.height - side) // 2
    avatar = avatar.crop((left, top, left + side, top + side)).resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)
    if participant.speaking:
        alpha = SPEAKING_ALPHA
    else:
        alpha = IDLE_ALPHA
    if alpha < 1.0:
        r, g, b, a = avatar.split()
        a = a.point(lambda value: int(value * alpha))
        avatar.putalpha(a)

    mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.ellipse((0, 0, AVATAR_SIZE - 1, AVATAR_SIZE - 1), fill=255)

    canvas = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 0))
    canvas.paste(avatar, (BORDER_WIDTH, BORDER_WIDTH), mask)
    draw = ImageDraw.Draw(canvas)
    inset = BORDER_WIDTH // 2
    draw.ellipse(
        (inset, inset, diameter - inset - 1, diameter - inset - 1),
        outline=SPEAKING_BORDER if participant.speaking else IDLE_BORDER,
        width=BORDER_WIDTH,
    )
    canvas.save(output)
    return output


class CallWidget(Gtk.Window):
    def __init__(self):
        super().__init__(title="record-call-widget")
        self.participants: list[Participant] = []
        self.grid: Gtk.Widget | None = None
        self.set_name("record-call-widget")
        try:
            self.set_wmclass("record-call-widget", "RecordCallWidget")
        except Exception:
            pass
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_app_paintable(True)
        self.set_accept_focus(False)
        self.set_focus_on_map(False)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_keep_above(True)
        self.set_type_hint(Gdk.WindowTypeHint.UTILITY)

        screen = self.get_screen()
        visual = screen.get_rgba_visual() if screen else None
        if visual is not None:
            self.set_visual(visual)
        self.install_transparent_css(screen)
        self.connect("delete-event", lambda *_: True)

    def install_transparent_css(self, screen: Gdk.Screen | None) -> None:
        if screen is None:
            return
        provider = Gtk.CssProvider()
        provider.load_from_data(b"""
            window, grid, image, label { background-color: transparent; }
            box.record-call-widget-card {
                background-color: rgba(7, 12, 22, 0.94);
                border: 1px solid rgba(148, 163, 184, 0.20);
                border-radius: 16px;
            }
            box.record-call-widget-row {
                background-color: rgba(15, 23, 42, 0.55);
                border: 1px solid rgba(148, 163, 184, 0.10);
                border-radius: 13px;
            }
            box.record-call-widget-row-speaking {
                background-color: rgba(20, 83, 45, 0.26);
                border-color: rgba(35, 165, 90, 0.42);
            }
            label.record-call-widget-name {
                font: 13px sans-serif;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.82);
            }
            label.record-call-widget-status {
                color: #94a3b8;
                font: 10px sans-serif;
                letter-spacing: 0.08em;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.82);
            }
            label.record-call-widget-status-speaking { color: #86efac; }
        """)
        Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def handle_message(self, message: dict[str, Any]) -> bool:
        if message.get("type") == "close":
            Gtk.main_quit()
            return False
        if message.get("type") != "update":
            return False
        raw = message.get("participants")
        self.participants = [Participant(item) for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
        if not self.participants:
            self.hide()
            return False
        self.rebuild_grid()
        self.resize_and_position()
        self.show_all()
        return False

    def desired_size(self) -> tuple[int, int]:
        rows = max(1, len(self.participants))
        diameter = AVATAR_SIZE + BORDER_WIDTH * 2
        row_height = max(diameter, 44) + ROW_PADDING_Y * 2
        row_width = ROW_PADDING_X * 2 + diameter + NAME_GAP + NAME_WIDTH
        width = CARD_PADDING * 2 + row_width
        height = CARD_PADDING * 2 + rows * row_height + max(0, rows - 1) * ROW_GAP
        return width, height

    def rebuild_grid(self) -> None:
        if self.grid is not None:
            self.remove(self.grid)
        diameter = AVATAR_SIZE + BORDER_WIDTH * 2
        row_height = max(diameter, 44) + ROW_PADDING_Y * 2
        row_width = ROW_PADDING_X * 2 + diameter + NAME_GAP + NAME_WIDTH

        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        card.set_name("record-call-widget-card")
        card.get_style_context().add_class("record-call-widget-card")

        inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=ROW_GAP)
        inner.set_margin_top(CARD_PADDING)
        inner.set_margin_bottom(CARD_PADDING)
        inner.set_margin_start(CARD_PADDING)
        inner.set_margin_end(CARD_PADDING)
        card.pack_start(inner, True, True, 0)

        for participant in self.participants:
            row_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=NAME_GAP)
            row_box.set_name("record-call-widget-row")
            row_box.set_size_request(row_width, row_height)
            row_style = row_box.get_style_context()
            row_style.add_class("record-call-widget-row")
            if participant.speaking:
                row_style.add_class("record-call-widget-row-speaking")

            image = Gtk.Image.new_from_file(str(render_avatar_path(participant)))
            image.set_size_request(diameter, diameter)
            image.set_halign(Gtk.Align.CENTER)
            image.set_valign(Gtk.Align.CENTER)
            image.set_margin_start(ROW_PADDING_X)
            image.set_margin_top(ROW_PADDING_Y)
            image.set_margin_bottom(ROW_PADDING_Y)
            row_box.pack_start(image, False, False, 0)

            label = Gtk.Label()
            label.set_markup(label_markup(participant))
            label.set_name("record-call-widget-name")
            label.get_style_context().add_class("record-call-widget-name")
            label.set_halign(Gtk.Align.START)
            label.set_valign(Gtk.Align.CENTER)
            label.set_xalign(0.0)
            label.set_width_chars(1)
            label.set_max_width_chars(22)
            label.set_ellipsize(Pango.EllipsizeMode.END)
            label.set_size_request(NAME_WIDTH, -1)
            label.set_opacity(1.0 if participant.speaking else 0.9)
            row_box.pack_start(label, True, True, 0)

            inner.pack_start(row_box, False, False, 0)
        self.grid = card
        self.add(card)

    def resize_and_position(self) -> None:
        width, height = self.desired_size()
        self.set_size_request(width, height)
        self.resize(width, height)
        screen = Gdk.Screen.get_default()
        if not screen:
            return
        monitor = screen.get_primary_monitor()
        if monitor < 0:
            monitor = 0
        geometry = screen.get_monitor_geometry(monitor)
        x = geometry.x + geometry.width - width - 24
        y = geometry.y + (geometry.height - height) // 2
        self.move(max(geometry.x, x), max(geometry.y, y))


def stdin_thread(widget: CallWidget) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except Exception as exc:
            print(f"record-call-widget: invalid json: {exc}", file=sys.stderr, flush=True)
            continue
        GLib.idle_add(widget.handle_message, message)
    GLib.idle_add(Gtk.main_quit)


def main() -> int:
    widget = CallWidget()
    thread = threading.Thread(target=stdin_thread, args=(widget,), daemon=True)
    thread.start()
    Gtk.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
