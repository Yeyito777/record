#define _GNU_SOURCE
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xrandr.h>
#include <X11/extensions/Xrender.h>
#include <cairo/cairo-xlib.h>
#include <curl/curl.h>
#include <errno.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <glib.h>
#include <json-c/json.h>
#include <math.h>
#include <pango/pangocairo.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define WIDGET_WIDTH 202
#define AVATAR_SIZE 34
#define BORDER_WIDTH 2
#define ROW_PADDING_X 5
#define ROW_PADDING_Y 4
#define NAME_GAP 8
#define ROW_GAP 5
#define STATUS_GAP 6
#define STATUS_ICON_SIZE 16
#define STATUS_ICON_GAP 4
#define STATUS_ICON_COLOR "#94a3b8"
#define RIGHT_MARGIN 5
#define ROW_RADIUS 11.0
#define IDLE_ALPHA 0.82
#define MAX_PARTICIPANTS 64

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

typedef struct {
  char *id;
  char *name;
  char *avatar_url;
  char *text_color;
  bool speaking;
  bool muted;
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
  g_free(p->avatar_url);
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

struct WriteFileCtx { FILE *file; };
static size_t curl_write_file(void *ptr, size_t size, size_t nmemb, void *userdata) {
  struct WriteFileCtx *ctx = (struct WriteFileCtx *)userdata;
  return fwrite(ptr, size, nmemb, ctx->file);
}

static char *avatar_cache_path(const char *url) {
  if (!url || !*url) return NULL;
  char *path = hex_hash_path("avatar", url, ".img");
  if (g_file_test(path, G_FILE_TEST_EXISTS)) return path;

  char *tmp = g_strdup_printf("%s.tmp", path);
  FILE *file = fopen(tmp, "wb");
  if (!file) { g_free(tmp); g_free(path); return NULL; }

  CURL *curl = curl_easy_init();
  bool ok = false;
  if (curl) {
    struct WriteFileCtx ctx = { .file = file };
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "record-call-widget-c/0.1");
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 8L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_file);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &ctx);
    CURLcode res = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    ok = (res == CURLE_OK && (status == 0 || (status >= 200 && status < 300)));
    curl_easy_cleanup(curl);
  }
  fclose(file);
  if (ok && rename(tmp, path) == 0) {
    g_free(tmp);
    return path;
  }
  unlink(tmp);
  g_free(tmp);
  g_free(path);
  return NULL;
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

static int reserved_status_width(void) {
  return 2 * STATUS_ICON_SIZE + STATUS_ICON_GAP;
}

static void desired_size(int *out_w, int *out_h) {
  int rows = participant_count > 0 ? (int)participant_count : 1;
  int diameter = AVATAR_SIZE + BORDER_WIDTH * 2;
  int row_h = diameter + ROW_PADDING_Y * 2;
  *out_w = WIDGET_WIDTH;
  *out_h = rows * row_h + (rows - 1) * ROW_GAP;
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

    XSetWindowAttributes attrs = {0};
    attrs.colormap = overlay.colormap;
    attrs.border_pixel = 0;
    attrs.background_pixel = 0;
    attrs.event_mask = ExposureMask | StructureNotifyMask;
    attrs.override_redirect = True;
    overlay.window = XCreateWindow(
      overlay.display,
      RootWindow(overlay.display, overlay.screen),
      0, 0, (unsigned int)width, (unsigned int)height,
      0, overlay.depth, InputOutput, overlay.visual,
      CWColormap | CWBorderPixel | CWBackPixel | CWEventMask | CWOverrideRedirect,
      &attrs
    );
    set_window_atoms();
    XMapRaised(overlay.display, overlay.window);
  }

  if (overlay.width != width || overlay.height != height || !overlay.surface) {
    destroy_cairo();
    overlay.width = width;
    overlay.height = height;
    XResizeWindow(overlay.display, overlay.window, (unsigned int)width, (unsigned int)height);
    overlay.surface = cairo_xlib_surface_create(overlay.display, overlay.window, overlay.visual, width, height);
    overlay.cr = cairo_create(overlay.surface);
  }

  int monitor_x = 0, monitor_y = 0, monitor_w = 0, monitor_h = 0;
  primary_monitor_geometry(&monitor_x, &monitor_y, &monitor_w, &monitor_h);
  int x = monitor_x + monitor_w - width - RIGHT_MARGIN;
  int y = monitor_y + (monitor_h - height) / 2;
  if (x < monitor_x) x = monitor_x;
  if (y < monitor_y) y = monitor_y;
  XMoveWindow(overlay.display, overlay.window, x, y);
  XRaiseWindow(overlay.display, overlay.window);
  return true;
}

static void rounded_rect(cairo_t *cr, double x, double y, double w, double h, double r) {
  double x2 = x + w;
  double y2 = y + h;
  cairo_new_sub_path(cr);
  cairo_arc(cr, x2 - r, y + r, r, -M_PI / 2, 0);
  cairo_arc(cr, x2 - r, y2 - r, r, 0, M_PI / 2);
  cairo_arc(cr, x + r, y2 - r, r, M_PI / 2, M_PI);
  cairo_arc(cr, x + r, y + r, r, M_PI, 3 * M_PI / 2);
  cairo_close_path(cr);
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
  (void)p;
  cairo_save(cr);
  cairo_arc(cr, x + size / 2, y + size / 2, size / 2, 0, 2 * M_PI);
  cairo_set_source_rgb(cr, 0.114, 0.608, 0.941);
  cairo_fill(cr);
  cairo_restore(cr);
}

static void draw_avatar(cairo_t *cr, const Participant *p, double x, double y) {
  int diameter = AVATAR_SIZE + BORDER_WIDTH * 2;
  double cx = x + diameter / 2.0;
  double cy = y + diameter / 2.0;

  char *cached = avatar_cache_path(p->avatar_url);
  GError *error = NULL;
  GdkPixbuf *pixbuf = cached ? gdk_pixbuf_new_from_file_at_scale(cached, AVATAR_SIZE, AVATAR_SIZE, TRUE, &error) : NULL;
  if (error) g_error_free(error);
  g_free(cached);

  cairo_save(cr);
  cairo_arc(cr, cx, cy, AVATAR_SIZE / 2.0, 0, 2 * M_PI);
  cairo_clip(cr);
  if (pixbuf) {
    int pw = gdk_pixbuf_get_width(pixbuf);
    int ph = gdk_pixbuf_get_height(pixbuf);
    double px = x + BORDER_WIDTH + (AVATAR_SIZE - pw) / 2.0;
    double py = y + BORDER_WIDTH + (AVATAR_SIZE - ph) / 2.0;
    cairo_surface_t *avatar_surface = surface_from_pixbuf(pixbuf);
    if (avatar_surface) {
      cairo_set_source_surface(cr, avatar_surface, px, py);
      cairo_paint_with_alpha(cr, p->speaking ? 1.0 : IDLE_ALPHA);
      cairo_surface_destroy(avatar_surface);
    }
    g_object_unref(pixbuf);
  } else {
    draw_placeholder(cr, p, x + BORDER_WIDTH, y + BORDER_WIDTH, AVATAR_SIZE);
  }
  cairo_restore(cr);

  if (p->speaking) cairo_set_source_rgba(cr, 0.137, 0.647, 0.353, 1.0);
  else cairo_set_source_rgba(cr, 0.188, 0.227, 0.290, 0.86);
  cairo_set_line_width(cr, BORDER_WIDTH);
  cairo_arc(cr, cx, cy, diameter / 2.0 - BORDER_WIDTH / 2.0, 0, 2 * M_PI);
  cairo_stroke(cr);
}

static void draw_text(cairo_t *cr, const Participant *p, double x, double y, int width, int row_h) {
  PangoLayout *layout = pango_cairo_create_layout(cr);
  PangoFontDescription *font = pango_font_description_from_string("JetBrains Mono 12");
  pango_layout_set_font_description(layout, font);
  pango_layout_set_width(layout, width * PANGO_SCALE);
  pango_layout_set_ellipsize(layout, PANGO_ELLIPSIZE_END);

  char *escaped = g_markup_escape_text(p->name ? p->name : "?", -1);
  char *markup = g_strdup_printf("<span foreground=\"%s\" weight=\"%s\">%s</span>",
                                 p->text_color ? p->text_color : "#f8fafc",
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

static void render(void) {
  int width = 0, height = 0;
  desired_size(&width, &height);
  if (participant_count == 0) {
    if (overlay.display && overlay.window) XUnmapWindow(overlay.display, overlay.window);
    return;
  }
  if (!ensure_window(width, height)) return;

  cairo_t *cr = overlay.cr;
  cairo_save(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
  cairo_paint(cr);
  cairo_restore(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

  int diameter = AVATAR_SIZE + BORDER_WIDTH * 2;
  int row_h = diameter + ROW_PADDING_Y * 2;
  int swidth = reserved_status_width();
  int nwidth = width - ROW_PADDING_X * 2 - diameter - NAME_GAP - STATUS_GAP - swidth - ROW_PADDING_X;
  if (nwidth < 24) nwidth = 24;
  int row_w = width;

  for (size_t i = 0; i < participant_count; i++) {
    Participant *p = &participants[i];
    double y = i * (row_h + ROW_GAP);

    rounded_rect(cr, 0.5, y + 0.5, row_w - 1.0, row_h - 1.0, ROW_RADIUS);
    if (p->speaking) cairo_set_source_rgba(cr, 0.078, 0.325, 0.176, 0.22);
    else cairo_set_source_rgba(cr, 0.059, 0.090, 0.165, 0.42);
    cairo_fill_preserve(cr);
    if (p->speaking) cairo_set_source_rgba(cr, 0.137, 0.647, 0.353, 0.38);
    else cairo_set_source_rgba(cr, 0.580, 0.639, 0.722, 0.08);
    cairo_set_line_width(cr, 1.0);
    cairo_stroke(cr);

    double avatar_x = ROW_PADDING_X;
    double avatar_y = y + ROW_PADDING_Y;
    draw_avatar(cr, p, avatar_x, avatar_y);

    double text_x = avatar_x + diameter + NAME_GAP;
    cairo_save(cr);
    rounded_rect(cr, 0.5, y + 0.5, row_w - 1.0, row_h - 1.0, ROW_RADIUS);
    cairo_clip(cr);
    draw_text(cr, p, text_x, y, nwidth, row_h);
    cairo_restore(cr);

    double icon_x = width - ROW_PADDING_X - swidth;
    double icon_y = y + (row_h - STATUS_ICON_SIZE) / 2.0;
    if (p->muted) {
      draw_icon(cr, "muted", icon_x, icon_y);
    }
    if (p->deafened) {
      draw_icon(cr, "deafened", icon_x + STATUS_ICON_SIZE + STATUS_ICON_GAP, icon_y);
    }
  }

  cairo_surface_flush(overlay.surface);
  XFlush(overlay.display);
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
    const char *avatar = json_string_or_null(item, "avatarUrl");
    const char *text_color = json_string_or_null(item, "textColor");
    if (!text_color) text_color = json_string_or_null(item, "roleColor");
    p->id = g_strdup(id ? id : "");
    p->name = g_strdup((name && *name) ? name : (id && *id ? id : "?"));
    p->avatar_url = g_strdup(avatar ? avatar : "");
    p->text_color = g_strdup(text_color ? text_color : "#f8fafc");
    p->speaking = json_get_bool(item, "speaking");
    p->muted = json_get_bool(item, "muted");
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
  curl_global_init(CURL_GLOBAL_DEFAULT);

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
  curl_global_cleanup();
  return 0;
}
