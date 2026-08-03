#define _GNU_SOURCE
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xrandr.h>
#include <X11/extensions/Xrender.h>
#include <cairo/cairo-xlib.h>
#include <errno.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <glib.h>
#include <json-c/json.h>
#include <pango/pangocairo.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define WIDGET_WIDTH 224
#define OUTER_BORDER_WIDTH 1
#define PANEL_PADDING 6
#define AVATAR_SIZE 32
#define AVATAR_BORDER_WIDTH 1
#define ROW_PADDING_X 6
#define ROW_PADDING_Y 5
#define NAME_GAP 8
#define ROW_GAP 1
#define STATUS_GAP 6
#define STATUS_ICON_SIZE 16
#define STATUS_ICON_GAP 4
#define STATUS_ICON_COLOR "#646464"
#define THEME_TEXT_COLOR "#ffffff"
#define RIGHT_MARGIN 5
#define MAX_PARTICIPANTS 64

typedef struct {
  double r;
  double g;
  double b;
} ThemeColor;

#define RGB_COLOR(r, g, b) { (r) / 255.0, (g) / 255.0, (b) / 255.0 }

/* Whale theme colors from vimbrowser/docs/design.md. */
static const ThemeColor COLOR_USER_BG = RGB_COLOR(0x09, 0x0d, 0x35);
static const ThemeColor COLOR_BORDER_FOCUSED = RGB_COLOR(0x1c, 0x94, 0xe5);
static const ThemeColor COLOR_BORDER_UNFOCUSED = RGB_COLOR(0x55, 0x55, 0x55);
static const double USER_BG_IDLE_ALPHA = 0.5;

typedef struct {
  char *id;
  char *name;
  char *avatar_path;
  char *text_color;
  bool speaking;
  bool muted;
  bool local_muted;
  bool deafened;
  bool self;
} Participant;

typedef struct {
  Display *display;
  int screen;
  Window window;
  Visual *visual;
  int depth;
  Colormap colormap;
  cairo_surface_t *surface;
  cairo_t *cr;
  int width;
  int height;
  int x;
  int y;
  bool positioned;
  bool mapped;
} Overlay;

static Participant participants[MAX_PARTICIPANTS];
static size_t participant_count = 0;
static Overlay overlay = {0};
static cairo_user_data_key_t surface_data_key;
static char *cache_dir = NULL;
static char *asset_dir = NULL;

static void free_participant(Participant *p) {
  g_free(p->id);
  g_free(p->name);
  g_free(p->avatar_path);
  g_free(p->text_color);
  memset(p, 0, sizeof(*p));
}

static void clear_participants(void) {
  for (size_t i = 0; i < participant_count; i++) free_participant(&participants[i]);
  participant_count = 0;
}

static char *path_join(const char *a, const char *b) {
  return g_build_filename(a, b, NULL);
}

static void ensure_cache_dir(void) {
  if (!cache_dir) {
    const char *xdg = getenv("XDG_CACHE_HOME");
    if (xdg && *xdg) cache_dir = g_build_filename(xdg, "record", "call-widget-c", NULL);
    else cache_dir = g_build_filename(g_get_home_dir(), ".cache", "record", "call-widget-c", NULL);
  }
  g_mkdir_with_parents(cache_dir, 0700);
}

static void init_asset_dir(const char *argv0) {
  char exe_path[4096];
  ssize_t len = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
  if (len > 0) {
    exe_path[len] = '\0';
    char *dir = g_path_get_dirname(exe_path);             // widgets/call-widget
    char *widgets = g_path_get_dirname(dir);              // widgets
    char *root = g_path_get_dirname(widgets);             // repo root
    asset_dir = g_build_filename(root, "assets", "call-widget", NULL);
    g_free(root); g_free(widgets); g_free(dir);
    return;
  }
  char *cwd = g_get_current_dir();
  (void)argv0;
  asset_dir = g_build_filename(cwd, "assets", "call-widget", NULL);
  g_free(cwd);
}

static uint64_t fnv1a64(const char *s) {
  uint64_t h = 1469598103934665603ULL;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    h ^= (uint64_t)*p;
    h *= 1099511628211ULL;
  }
  return h;
}

static char *hex_hash_path(const char *prefix, const char *value, const char *suffix) {
  ensure_cache_dir();
  char name[128];
  snprintf(name, sizeof(name), "%s-%016llx%s", prefix, (unsigned long long)fnv1a64(value ? value : ""), suffix);
  return path_join(cache_dir, name);
}

static char *status_icon_path(const char *name) {
  ensure_cache_dir();
  char *asset_name = g_strdup_printf("%s.svg", strcmp(name, "muted") == 0 ? "mic-muted" : "headphones-deafened");
  char *source = path_join(asset_dir, asset_name);
  g_free(asset_name);
  if (!g_file_test(source, G_FILE_TEST_EXISTS)) { g_free(source); return NULL; }

  char *key = g_strdup_printf("%s-%s", name, STATUS_ICON_COLOR);
  char *out = hex_hash_path("status", key, ".svg");
  g_free(key);
  if (g_file_test(out, G_FILE_TEST_EXISTS)) { g_free(source); return out; }

  gchar *contents = NULL;
  gsize len = 0;
  if (!g_file_get_contents(source, &contents, &len, NULL)) { g_free(source); g_free(out); return NULL; }
  char **parts = g_strsplit(contents, "currentColor", -1);
  char *colored = g_strjoinv(STATUS_ICON_COLOR, parts);
  g_strfreev(parts);
  g_free(contents);
  g_file_set_contents(out, colored, -1, NULL);
  g_free(colored);
  g_free(source);
  return out;
}

static int status_width_for_count(int count) {
  if (count <= 0) return 0;
  return count * STATUS_ICON_SIZE + (count - 1) * STATUS_ICON_GAP;
}

static int participant_status_count(const Participant *p) {
  int count = 0;
  if (p->muted) count++;
  if (p->local_muted) count++;
  if (p->deafened) count++;
  return count;
}

static void set_source_theme(cairo_t *cr, ThemeColor color) {
  cairo_set_source_rgb(cr, color.r, color.g, color.b);
}

static void set_source_theme_alpha(cairo_t *cr, ThemeColor color, double alpha) {
  cairo_set_source_rgba(cr, color.r, color.g, color.b, alpha);
}

static void fill_rect(cairo_t *cr, double x, double y, double w, double h, ThemeColor color) {
  cairo_rectangle(cr, x, y, w, h);
  set_source_theme(cr, color);
  cairo_fill(cr);
}

static void fill_rect_alpha(cairo_t *cr, double x, double y, double w, double h, ThemeColor color, double alpha) {
  cairo_rectangle(cr, x, y, w, h);
  set_source_theme_alpha(cr, color, alpha);
  cairo_fill(cr);
}

static void stroke_rect(cairo_t *cr, double x, double y, double w, double h, ThemeColor color, double line_width) {
  cairo_rectangle(cr, x + line_width / 2.0, y + line_width / 2.0, w - line_width, h - line_width);
  set_source_theme(cr, color);
  cairo_set_line_width(cr, line_width);
  cairo_stroke(cr);
}

static void desired_size(int *out_w, int *out_h) {
  int rows = participant_count > 0 ? (int)participant_count : 1;
  int avatar_box = AVATAR_SIZE + AVATAR_BORDER_WIDTH * 2;
  int row_h = avatar_box + ROW_PADDING_Y * 2;
  *out_w = WIDGET_WIDTH;
  *out_h = OUTER_BORDER_WIDTH * 2 + PANEL_PADDING * 2 + rows * row_h + (rows - 1) * ROW_GAP;
}

static Visual *find_argb_visual(Display *dpy, int screen, int *depth_out) {
  XVisualInfo template = {0};
  template.screen = screen;
  template.depth = 32;
  int count = 0;
  XVisualInfo *infos = XGetVisualInfo(dpy, VisualScreenMask | VisualDepthMask, &template, &count);
  if (!infos) return DefaultVisual(dpy, screen);
  Visual *result = NULL;
  for (int i = 0; i < count; i++) {
    XRenderPictFormat *format = XRenderFindVisualFormat(dpy, infos[i].visual);
    if (format && format->type == PictTypeDirect && format->direct.alphaMask) {
      result = infos[i].visual;
      *depth_out = infos[i].depth;
      break;
    }
  }
  XFree(infos);
  if (!result) {
    *depth_out = DefaultDepth(dpy, screen);
    result = DefaultVisual(dpy, screen);
  }
  return result;
}

static void set_window_atoms(void) {
  Display *d = overlay.display;
  Window w = overlay.window;
  XStoreName(d, w, "record-call-widget");
  XClassHint class_hint = { .res_name = "record-call-widget", .res_class = "RecordCallWidget" };
  XSetClassHint(d, w, &class_hint);

  Atom type_prop = XInternAtom(d, "_NET_WM_WINDOW_TYPE", False);
  Atom type_dock = XInternAtom(d, "_NET_WM_WINDOW_TYPE_DOCK", False);
  XChangeProperty(d, w, type_prop, XA_ATOM, 32, PropModeReplace, (unsigned char *)&type_dock, 1);

  Atom state_prop = XInternAtom(d, "_NET_WM_STATE", False);
  Atom states[3] = {
    XInternAtom(d, "_NET_WM_STATE_ABOVE", False),
    XInternAtom(d, "_NET_WM_STATE_SKIP_TASKBAR", False),
    XInternAtom(d, "_NET_WM_STATE_SKIP_PAGER", False),
  };
  XChangeProperty(d, w, state_prop, XA_ATOM, 32, PropModeReplace, (unsigned char *)states, 3);

  Atom motif = XInternAtom(d, "_MOTIF_WM_HINTS", False);
  unsigned long hints[5] = {2, 0, 0, 0, 0};
  XChangeProperty(d, w, motif, motif, 32, PropModeReplace, (unsigned char *)hints, 5);
}

static void destroy_cairo(void) {
  if (overlay.cr) cairo_destroy(overlay.cr);
  if (overlay.surface) cairo_surface_destroy(overlay.surface);
  overlay.cr = NULL;
  overlay.surface = NULL;
}

static void primary_monitor_geometry(int *out_x, int *out_y, int *out_w, int *out_h) {
  Display *d = overlay.display;
  Window root = RootWindow(d, overlay.screen);
  Screen *screen = ScreenOfDisplay(d, overlay.screen);
  *out_x = 0;
  *out_y = 0;
  *out_w = WidthOfScreen(screen);
  *out_h = HeightOfScreen(screen);

  int event_base = 0, error_base = 0;
  if (!XRRQueryExtension(d, &event_base, &error_base)) return;

  int monitor_count = 0;
  XRRMonitorInfo *monitors = XRRGetMonitors(d, root, True, &monitor_count);
  if (!monitors || monitor_count <= 0) {
    if (monitors) XRRFreeMonitors(monitors);
    return;
  }

  int selected = -1;
  for (int i = 0; i < monitor_count; i++) {
    if (monitors[i].primary) {
      selected = i;
      break;
    }
  }

  if (selected < 0) {
    Window child = 0, root_return = 0;
    int root_x = 0, root_y = 0, win_x = 0, win_y = 0;
    unsigned int mask = 0;
    if (XQueryPointer(d, root, &root_return, &child, &root_x, &root_y, &win_x, &win_y, &mask)) {
      for (int i = 0; i < monitor_count; i++) {
        if (root_x >= monitors[i].x && root_x < monitors[i].x + monitors[i].width
            && root_y >= monitors[i].y && root_y < monitors[i].y + monitors[i].height) {
          selected = i;
          break;
        }
      }
    }
  }

  if (selected < 0) selected = 0;
  *out_x = monitors[selected].x;
  *out_y = monitors[selected].y;
  *out_w = monitors[selected].width;
  *out_h = monitors[selected].height;
  XRRFreeMonitors(monitors);
}

static bool ensure_window(int width, int height) {
  if (!overlay.display) {
    overlay.display = XOpenDisplay(NULL);
    if (!overlay.display) { fprintf(stderr, "record-call-widget-c: failed to open X display\n"); return false; }
    overlay.screen = DefaultScreen(overlay.display);
    overlay.depth = DefaultDepth(overlay.display, overlay.screen);
    overlay.visual = find_argb_visual(overlay.display, overlay.screen, &overlay.depth);
    overlay.colormap = XCreateColormap(overlay.display, RootWindow(overlay.display, overlay.screen), overlay.visual, AllocNone);
  }

  int monitor_x = 0, monitor_y = 0, monitor_w = 0, monitor_h = 0;
  primary_monitor_geometry(&monitor_x, &monitor_y, &monitor_w, &monitor_h);
  int x = monitor_x + monitor_w - width - RIGHT_MARGIN;
  int y = monitor_y + (monitor_h - height) / 2;
  if (x < monitor_x) x = monitor_x;
  if (y < monitor_y) y = monitor_y;

  if (!overlay.window) {
    XSetWindowAttributes attrs = {0};
    attrs.colormap = overlay.colormap;
    attrs.border_pixel = 0;
    attrs.background_pixel = 0;
    attrs.event_mask = ExposureMask | StructureNotifyMask;
    attrs.override_redirect = True;
    overlay.window = XCreateWindow(
      overlay.display,
      RootWindow(overlay.display, overlay.screen),
      x, y, (unsigned int)width, (unsigned int)height,
      0, overlay.depth, InputOutput, overlay.visual,
      CWColormap | CWBorderPixel | CWBackPixel | CWEventMask | CWOverrideRedirect,
      &attrs
    );
    overlay.x = x;
    overlay.y = y;
    overlay.positioned = true;
    set_window_atoms();
  }

  if (overlay.width != width || overlay.height != height || !overlay.surface) {
    destroy_cairo();
    overlay.width = width;
    overlay.height = height;
    XResizeWindow(overlay.display, overlay.window, (unsigned int)width, (unsigned int)height);
    overlay.surface = cairo_xlib_surface_create(overlay.display, overlay.window, overlay.visual, width, height);
    overlay.cr = cairo_create(overlay.surface);
  }

  if (!overlay.positioned || overlay.x != x || overlay.y != y) {
    XMoveWindow(overlay.display, overlay.window, x, y);
    overlay.x = x;
    overlay.y = y;
    overlay.positioned = true;
  }
  return true;
}

static void paint_target(cairo_surface_t *source) {
  cairo_save(overlay.cr);
  cairo_set_operator(overlay.cr, CAIRO_OPERATOR_SOURCE);
  cairo_set_source_surface(overlay.cr, source, 0, 0);
  cairo_paint(overlay.cr);
  cairo_restore(overlay.cr);
  cairo_surface_flush(overlay.surface);
}

static void present_surface(cairo_surface_t *source) {
  if (!overlay.cr || !overlay.surface || !overlay.display || !overlay.window) return;
  paint_target(source);
  if (!overlay.mapped) {
    XMapRaised(overlay.display, overlay.window);
    overlay.mapped = true;
    paint_target(source);
  }
  XFlush(overlay.display);
}

static cairo_surface_t *surface_from_pixbuf(GdkPixbuf *pixbuf) {
  int width = gdk_pixbuf_get_width(pixbuf);
  int height = gdk_pixbuf_get_height(pixbuf);
  int channels = gdk_pixbuf_get_n_channels(pixbuf);
  int rowstride = gdk_pixbuf_get_rowstride(pixbuf);
  guchar *src = gdk_pixbuf_get_pixels(pixbuf);
  int dst_stride = cairo_format_stride_for_width(CAIRO_FORMAT_ARGB32, width);
  unsigned char *dst = (unsigned char *)calloc((size_t)dst_stride, (size_t)height);
  if (!dst) return NULL;

  for (int y = 0; y < height; y++) {
    uint32_t *row = (uint32_t *)(dst + y * dst_stride);
    guchar *src_row = src + y * rowstride;
    for (int x = 0; x < width; x++) {
      guchar *px = src_row + x * channels;
      uint32_t r = px[0];
      uint32_t g = px[1];
      uint32_t b = px[2];
      uint32_t a = channels >= 4 ? px[3] : 255;
      r = (r * a + 127) / 255;
      g = (g * a + 127) / 255;
      b = (b * a + 127) / 255;
      row[x] = (a << 24) | (r << 16) | (g << 8) | b;
    }
  }

  cairo_surface_t *surface = cairo_image_surface_create_for_data(dst, CAIRO_FORMAT_ARGB32, width, height, dst_stride);
  if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
    free(dst);
    cairo_surface_destroy(surface);
    return NULL;
  }
  cairo_surface_set_user_data(surface, &surface_data_key, dst, free);
  return surface;
}

static void draw_placeholder(cairo_t *cr, const Participant *p, double x, double y, double size) {
  uint64_t hash = fnv1a64(p->id && *p->id ? p->id : (p->name ? p->name : "?"));
  ThemeColor background = {
    .r = 0.20 + ((hash >> 0) & 0xff) / 255.0 * 0.22,
    .g = 0.22 + ((hash >> 8) & 0xff) / 255.0 * 0.22,
    .b = 0.28 + ((hash >> 16) & 0xff) / 255.0 * 0.24,
  };
  fill_rect(cr, x, y, size, size, background);

  const char *label = p->name && *p->name ? p->name : "?";
  const char *next = g_utf8_next_char(label);
  char *initial = g_utf8_strup(label, (gssize)(next - label));
  PangoLayout *layout = pango_cairo_create_layout(cr);
  PangoFontDescription *font = pango_font_description_from_string("Sans Bold 14");
  pango_layout_set_font_description(layout, font);
  pango_layout_set_text(layout, initial, -1);
  int tw = 0, th = 0;
  pango_layout_get_pixel_size(layout, &tw, &th);
  cairo_move_to(cr, x + (size - tw) / 2.0, y + (size - th) / 2.0 - 1.0);
  cairo_set_source_rgb(cr, 1.0, 1.0, 1.0);
  pango_cairo_show_layout(cr, layout);
  pango_font_description_free(font);
  g_object_unref(layout);
  g_free(initial);
}

static void draw_avatar(cairo_t *cr, const Participant *p, double x, double y) {
  int avatar_box = AVATAR_SIZE + AVATAR_BORDER_WIDTH * 2;
  double image_x = x + AVATAR_BORDER_WIDTH;
  double image_y = y + AVATAR_BORDER_WIDTH;

  GError *error = NULL;
  GdkPixbuf *pixbuf = p->avatar_path && *p->avatar_path
    ? gdk_pixbuf_new_from_file_at_scale(p->avatar_path, AVATAR_SIZE, AVATAR_SIZE, TRUE, &error)
    : NULL;
  if (error) {
    fprintf(stderr, "record-call-widget-c: avatar decode failed: %s\n", error->message);
    if (p->avatar_path && *p->avatar_path) unlink(p->avatar_path);
    g_error_free(error);
  }

  cairo_save(cr);
  cairo_rectangle(cr, image_x, image_y, AVATAR_SIZE, AVATAR_SIZE);
  cairo_clip(cr);
  if (pixbuf) {
    int pw = gdk_pixbuf_get_width(pixbuf);
    int ph = gdk_pixbuf_get_height(pixbuf);
    double px = image_x + (AVATAR_SIZE - pw) / 2.0;
    double py = image_y + (AVATAR_SIZE - ph) / 2.0;
    cairo_surface_t *avatar_surface = surface_from_pixbuf(pixbuf);
    if (avatar_surface) {
      cairo_set_source_surface(cr, avatar_surface, px, py);
      cairo_paint(cr);
      cairo_surface_destroy(avatar_surface);
    }
    g_object_unref(pixbuf);
  } else {
    draw_placeholder(cr, p, image_x, image_y, AVATAR_SIZE);
  }
  cairo_restore(cr);

  stroke_rect(cr, x, y, avatar_box, avatar_box, p->speaking ? COLOR_BORDER_FOCUSED : COLOR_BORDER_UNFOCUSED, AVATAR_BORDER_WIDTH);
}

static void draw_text(cairo_t *cr, const Participant *p, double x, double y, int width, int row_h) {
  PangoLayout *layout = pango_cairo_create_layout(cr);
  PangoFontDescription *font = pango_font_description_from_string("JetBrains Mono 12");
  pango_layout_set_font_description(layout, font);
  pango_layout_set_width(layout, width * PANGO_SCALE);
  pango_layout_set_ellipsize(layout, PANGO_ELLIPSIZE_END);

  char *escaped = g_markup_escape_text(p->name ? p->name : "?", -1);
  char *markup = g_strdup_printf("<span foreground=\"%s\" weight=\"%s\">%s</span>",
                                 p->text_color ? p->text_color : THEME_TEXT_COLOR,
                                 p->speaking ? "700" : "500",
                                 escaped);
  pango_layout_set_markup(layout, markup, -1);
  int tw = 0, th = 0;
  pango_layout_get_pixel_size(layout, &tw, &th);
  cairo_move_to(cr, x, y + (row_h - th) / 2.0 - 1.0);
  pango_cairo_show_layout(cr, layout);

  g_free(markup);
  g_free(escaped);
  pango_font_description_free(font);
  g_object_unref(layout);
}

static void draw_icon(cairo_t *cr, const char *name, double x, double y) {
  char *path = status_icon_path(name);
  if (!path) return;
  GError *error = NULL;
  GdkPixbuf *pixbuf = gdk_pixbuf_new_from_file_at_scale(path, STATUS_ICON_SIZE, STATUS_ICON_SIZE, TRUE, &error);
  if (error) g_error_free(error);
  g_free(path);
  if (!pixbuf) return;
  cairo_surface_t *surface = surface_from_pixbuf(pixbuf);
  if (surface) {
    cairo_set_source_surface(cr, surface, x, y);
    cairo_paint(cr);
    cairo_surface_destroy(surface);
  }
  g_object_unref(pixbuf);
}

static void draw_emoji_icon(cairo_t *cr, const char *emoji, double x, double y) {
  PangoLayout *layout = pango_cairo_create_layout(cr);
  PangoFontDescription *font = pango_font_description_from_string("Sans 13");
  pango_layout_set_font_description(layout, font);
  pango_layout_set_width(layout, STATUS_ICON_SIZE * PANGO_SCALE);
  pango_layout_set_alignment(layout, PANGO_ALIGN_CENTER);
  char *markup = g_strdup_printf("<span foreground=\"%s\">%s</span>", THEME_TEXT_COLOR, emoji);
  pango_layout_set_markup(layout, markup, -1);

  int tw = 0, th = 0;
  pango_layout_get_pixel_size(layout, &tw, &th);
  cairo_move_to(cr, x + (STATUS_ICON_SIZE - tw) / 2.0, y + (STATUS_ICON_SIZE - th) / 2.0);
  pango_cairo_show_layout(cr, layout);

  g_free(markup);
  pango_font_description_free(font);
  g_object_unref(layout);
}

static double draw_participant_status_icons(cairo_t *cr, const Participant *p, double x, double y) {
  if (p->muted) {
    draw_icon(cr, "muted", x, y);
    x += STATUS_ICON_SIZE + STATUS_ICON_GAP;
  }
  if (p->local_muted) {
    draw_emoji_icon(cr, "🔕", x, y);
    x += STATUS_ICON_SIZE + STATUS_ICON_GAP;
  }
  if (p->deafened) {
    draw_icon(cr, "deafened", x, y);
    x += STATUS_ICON_SIZE + STATUS_ICON_GAP;
  }
  return x;
}

static void render(void) {
  int width = 0, height = 0;
  desired_size(&width, &height);
  if (participant_count == 0) {
    if (overlay.display && overlay.window && overlay.mapped) {
      XUnmapWindow(overlay.display, overlay.window);
      overlay.mapped = false;
      XFlush(overlay.display);
    }
    return;
  }
  if (!ensure_window(width, height)) return;

  cairo_surface_t *frame = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
  if (cairo_surface_status(frame) != CAIRO_STATUS_SUCCESS) {
    cairo_surface_destroy(frame);
    return;
  }
  cairo_t *cr = cairo_create(frame);
  cairo_save(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
  cairo_paint(cr);
  cairo_restore(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

  int avatar_box = AVATAR_SIZE + AVATAR_BORDER_WIDTH * 2;
  int row_h = avatar_box + ROW_PADDING_Y * 2;
  int content_x = OUTER_BORDER_WIDTH + PANEL_PADDING;
  int content_y = OUTER_BORDER_WIDTH + PANEL_PADDING;
  int content_w = width - (OUTER_BORDER_WIDTH + PANEL_PADDING) * 2;
  int row_w = content_w;

  for (size_t i = 0; i < participant_count; i++) {
    Participant *p = &participants[i];
    double y = content_y + i * (row_h + ROW_GAP);
    double row_x = content_x;

    if (p->speaking) fill_rect(cr, row_x, y, row_w, row_h, COLOR_USER_BG);
    else fill_rect_alpha(cr, row_x, y, row_w, row_h, COLOR_USER_BG, USER_BG_IDLE_ALPHA);
    stroke_rect(cr, row_x, y, row_w, row_h, p->speaking ? COLOR_BORDER_FOCUSED : COLOR_BORDER_UNFOCUSED, 1.0);

    double avatar_x = row_x + ROW_PADDING_X;
    double avatar_y = y + ROW_PADDING_Y;
    draw_avatar(cr, p, avatar_x, avatar_y);

    int swidth = status_width_for_count(participant_status_count(p));
    int nwidth = row_w - ROW_PADDING_X * 2 - avatar_box - NAME_GAP - (swidth > 0 ? STATUS_GAP + swidth : 0);
    if (nwidth < 24) nwidth = 24;
    double text_x = avatar_x + avatar_box + NAME_GAP;
    cairo_save(cr);
    cairo_rectangle(cr, row_x, y, row_w, row_h);
    cairo_clip(cr);
    draw_text(cr, p, text_x, y, nwidth, row_h);
    cairo_restore(cr);

    double icon_x = row_x + row_w - ROW_PADDING_X - swidth;
    double icon_y = y + (row_h - STATUS_ICON_SIZE) / 2.0;
    draw_participant_status_icons(cr, p, icon_x, icon_y);
  }

  cairo_destroy(cr);
  present_surface(frame);
  cairo_surface_destroy(frame);
}

static const char *json_string_or_null(json_object *obj, const char *key) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(obj, key, &value) || json_object_is_type(value, json_type_null)) return NULL;
  if (!json_object_is_type(value, json_type_string)) return NULL;
  return json_object_get_string(value);
}

static bool json_get_bool(json_object *obj, const char *key) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(obj, key, &value)) return false;
  return json_object_get_boolean(value);
}

static void handle_update(json_object *root) {
  json_object *array = NULL;
  if (!json_object_object_get_ex(root, "participants", &array) || !json_object_is_type(array, json_type_array)) return;
  clear_participants();
  size_t len = json_object_array_length(array);
  if (len > MAX_PARTICIPANTS) len = MAX_PARTICIPANTS;
  for (size_t i = 0; i < len; i++) {
    json_object *item = json_object_array_get_idx(array, i);
    if (!json_object_is_type(item, json_type_object)) continue;
    Participant *p = &participants[participant_count++];
    const char *id = json_string_or_null(item, "id");
    const char *name = json_string_or_null(item, "name");
    const char *avatar_path = json_string_or_null(item, "avatarPath");
    const char *text_color = json_string_or_null(item, "textColor");
    if (!text_color) text_color = json_string_or_null(item, "roleColor");
    p->id = g_strdup(id ? id : "");
    p->name = g_strdup((name && *name) ? name : (id && *id ? id : "?"));
    p->avatar_path = g_strdup(avatar_path ? avatar_path : "");
    p->text_color = g_strdup(text_color ? text_color : THEME_TEXT_COLOR);
    p->speaking = json_get_bool(item, "speaking");
    p->muted = json_get_bool(item, "muted");
    p->local_muted = json_get_bool(item, "localMuted");
    p->deafened = json_get_bool(item, "deafened");
    p->self = json_get_bool(item, "self");
  }
  render();
}

static bool handle_line(const char *line) {
  json_object *root = json_tokener_parse(line);
  if (!root) return true;
  const char *type = json_string_or_null(root, "type");
  if (type && strcmp(type, "close") == 0) {
    json_object_put(root);
    return false;
  }
  if (type && strcmp(type, "update") == 0) handle_update(root);
  json_object_put(root);
  return true;
}

int main(int argc, char **argv) {
  init_asset_dir(argc > 0 ? argv[0] : NULL);
  ensure_cache_dir();

  char *line = NULL;
  size_t cap = 0;
  while (getline(&line, &cap, stdin) != -1) {
    if (!handle_line(line)) break;
  }
  free(line);

  clear_participants();
  destroy_cairo();
  if (overlay.display && overlay.window) XDestroyWindow(overlay.display, overlay.window);
  if (overlay.display && overlay.colormap) XFreeColormap(overlay.display, overlay.colormap);
  if (overlay.display) XCloseDisplay(overlay.display);
  g_free(cache_dir);
  g_free(asset_dir);
  return 0;
}
