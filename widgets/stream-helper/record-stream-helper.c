#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/shape.h>
#include <X11/extensions/Xinerama.h>
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

struct geometry {
    int x;
    int y;
    int w;
    int h;
};

struct options {
    int video_port;
    int audio_port;
    unsigned video_ssrc;
    unsigned audio_ssrc;
    pid_t parent_pid;
};

static volatile sig_atomic_t running = 1;
static pid_t ffmpeg_pid = -1;

static void on_signal(int sig)
{
    (void)sig;
    running = 0;
    if (ffmpeg_pid > 0)
        kill(ffmpeg_pid, SIGTERM);
}

static void usage(FILE *out)
{
    fprintf(out,
        "Usage: record-stream-helper --audio-port PORT [--video-ssrc SSRC] --audio-ssrc SSRC [--parent-pid PID]\n"
        "\n"
        "Captures the first X11 monitor and default PulseAudio/PipeWire monitor,\n"
        "writes Annex-B H.264 video to stdout, sends Opus RTP to localhost,\n"
        "and draws a purple outline around\n"
        "the captured monitor.\n");
}

static int parse_uint(const char *text, unsigned *out)
{
    char *end = NULL;
    unsigned long value;
    errno = 0;
    value = strtoul(text, &end, 10);
    if (errno || !end || *end || value > 0xffffffffUL)
        return -1;
    *out = (unsigned)value;
    return 0;
}

static int parse_int(const char *text, int *out)
{
    char *end = NULL;
    long value;
    errno = 0;
    value = strtol(text, &end, 10);
    if (errno || !end || *end || value < 0 || value > 65535)
        return -1;
    *out = (int)value;
    return 0;
}

static int parse_options(int argc, char **argv, struct options *opts)
{
    memset(opts, 0, sizeof(*opts));
    for (int i = 1; i < argc; ++i) {
        const char *arg = argv[i];
        if (!strcmp(arg, "--help") || !strcmp(arg, "-h")) {
            usage(stdout);
            exit(0);
        } else if (!strcmp(arg, "--video-port") && i + 1 < argc) {
            if (parse_int(argv[++i], &opts->video_port) < 0) return -1;
        } else if (!strcmp(arg, "--audio-port") && i + 1 < argc) {
            if (parse_int(argv[++i], &opts->audio_port) < 0) return -1;
        } else if (!strcmp(arg, "--video-ssrc") && i + 1 < argc) {
            if (parse_uint(argv[++i], &opts->video_ssrc) < 0) return -1;
        } else if (!strcmp(arg, "--audio-ssrc") && i + 1 < argc) {
            if (parse_uint(argv[++i], &opts->audio_ssrc) < 0) return -1;
        } else if (!strcmp(arg, "--parent-pid") && i + 1 < argc) {
            unsigned value;
            if (parse_uint(argv[++i], &value) < 0) return -1;
            opts->parent_pid = (pid_t)value;
        } else {
            return -1;
        }
    }
    return opts->audio_port > 0 && opts->audio_ssrc != 0 ? 0 : -1;
}

static unsigned long alloc_indicator_color(Display *dpy, int screen)
{
    Colormap cmap = DefaultColormap(dpy, screen);
    XColor color;
    XColor exact;
    if (XAllocNamedColor(dpy, cmap, "#a855f7", &color, &exact))
        return color.pixel;
    if (XAllocNamedColor(dpy, cmap, "purple", &color, &exact))
        return color.pixel;
    return WhitePixel(dpy, screen);
}

static void make_window_clickthrough(Display *dpy, Window root, Window win, unsigned width, unsigned height)
{
    int shape_event_base;
    int shape_error_base;
    if (!XShapeQueryExtension(dpy, &shape_event_base, &shape_error_base))
        return;
#ifdef ShapeInput
    Pixmap input_mask = XCreatePixmap(dpy, root, width, height, 1);
    GC gc = XCreateGC(dpy, input_mask, 0, NULL);
    XSetForeground(dpy, gc, 0);
    XFillRectangle(dpy, input_mask, gc, 0, 0, width, height);
    XFreeGC(dpy, gc);
    XShapeCombineMask(dpy, win, ShapeInput, 0, 0, input_mask, ShapeSet);
    XFreePixmap(dpy, input_mask);
#else
    (void)root;
    (void)width;
    (void)height;
#endif
}

static Window create_overlay_window(Display *dpy, Window root, int x, int y, unsigned width, unsigned height, unsigned long pixel)
{
    XSetWindowAttributes attrs;
    memset(&attrs, 0, sizeof(attrs));
    attrs.override_redirect = True;
    attrs.border_pixel = 0;
    attrs.background_pixel = pixel;
    attrs.event_mask = ExposureMask;
    Window win = XCreateWindow(dpy, root, x, y, width, height, 0,
                               CopyFromParent, InputOutput, CopyFromParent,
                               CWOverrideRedirect | CWBorderPixel | CWBackPixel | CWEventMask,
                               &attrs);
    if (!win)
        return 0;
    XStoreName(dpy, win, "record stream outline");
    make_window_clickthrough(dpy, root, win, width, height);
    XMapRaised(dpy, win);
    return win;
}

static void position_border_windows(Display *dpy, Window border[4], int screen_w, int screen_h, const struct geometry *geo)
{
    int left_x = geo->x > 0 ? geo->x - 2 : geo->x;
    int right_x = geo->x + geo->w < screen_w ? geo->x + geo->w : geo->x + geo->w - 2;
    int top_y = geo->y > 0 ? geo->y - 2 : geo->y;
    int bottom_y = geo->y + geo->h < screen_h ? geo->y + geo->h : geo->y + geo->h - 2;
    int horiz_w = geo->w + (geo->x > 0 ? 2 : 0) + (geo->x + geo->w < screen_w ? 2 : 0);
    if (horiz_w < 2) horiz_w = 2;
    XMoveResizeWindow(dpy, border[0], left_x, top_y, (unsigned)horiz_w, 2);
    XMoveResizeWindow(dpy, border[1], left_x, bottom_y, (unsigned)horiz_w, 2);
    XMoveResizeWindow(dpy, border[2], left_x, geo->y, 2, (unsigned)(geo->h > 0 ? geo->h : 2));
    XMoveResizeWindow(dpy, border[3], right_x, geo->y, 2, (unsigned)(geo->h > 0 ? geo->h : 2));
    for (int i = 0; i < 4; ++i)
        XMapRaised(dpy, border[i]);
}

static int first_monitor_geometry(Display *dpy, int screen, struct geometry *geo)
{
    int event_base, error_base;
    if (XineramaQueryExtension(dpy, &event_base, &error_base) && XineramaIsActive(dpy)) {
        int count = 0;
        XineramaScreenInfo *screens = XineramaQueryScreens(dpy, &count);
        if (screens && count > 0) {
            geo->x = screens[0].x_org;
            geo->y = screens[0].y_org;
            geo->w = screens[0].width;
            geo->h = screens[0].height;
            XFree(screens);
            return 0;
        }
        if (screens)
            XFree(screens);
    }
    geo->x = 0;
    geo->y = 0;
    geo->w = DisplayWidth(dpy, screen);
    geo->h = DisplayHeight(dpy, screen);
    return geo->w > 0 && geo->h > 0 ? 0 : -1;
}

static int start_ffmpeg(const struct options *opts, const struct geometry *geo)
{
    char audio_port[32], audio_ssrc[32];
    char video_size[64], display_input[128], audio_url[128];
    const char *display = getenv("DISPLAY");
    if (!display || !*display)
        display = ":0";

    snprintf(audio_port, sizeof(audio_port), "%d", opts->audio_port);
    snprintf(audio_ssrc, sizeof(audio_ssrc), "%u", opts->audio_ssrc);
    snprintf(video_size, sizeof(video_size), "%dx%d", geo->w & ~1, geo->h & ~1);
    snprintf(display_input, sizeof(display_input), "%s+%d,%d", display, geo->x, geo->y);
    snprintf(audio_url, sizeof(audio_url), "rtp://127.0.0.1:%s?pkt_size=1200", audio_port);

    pid_t pid = fork();
    if (pid < 0)
        return -1;
    if (pid == 0) {
        execlp("ffmpeg", "ffmpeg",
               "-hide_banner", "-loglevel", "warning", "-nostdin",
               "-f", "x11grab", "-draw_mouse", "1", "-framerate", "30",
               "-video_size", video_size, "-i", display_input,
               "-f", "pulse", "-i", "@DEFAULT_MONITOR@",
               "-map", "0:v:0", "-an",
               "-vf", "scale=1280:-2",
               "-c:v", "libx264", "-preset", "faster", "-tune", "zerolatency",
               "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "1", "-keyint_min", "1", "-bf", "0",
               "-b:v", "6500k", "-maxrate", "6500k", "-bufsize", "13000k",
               "-x264-params", "aud=1:repeat-headers=1:scenecut=0",
               "-bsf:v", "filter_units=remove_types=6",
               "-f", "h264", "pipe:1",
               "-map", "1:a:0", "-vn",
               "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-b:a", "96k",
               "-payload_type", "120", "-ssrc", audio_ssrc, "-f", "rtp", audio_url,
               (char *)NULL);
        fprintf(stderr, "record-stream-helper: failed to exec ffmpeg: %s\n", strerror(errno));
        _exit(127);
    }
    ffmpeg_pid = pid;
    return 0;
}

int main(int argc, char **argv)
{
    struct options opts;
    Display *dpy;
    int screen;
    Window root;
    Window border[4] = {0, 0, 0, 0};
    struct geometry geo;
    unsigned long pixel;
    int exit_status = 0;

    if (parse_options(argc, argv, &opts) < 0) {
        usage(stderr);
        return 2;
    }

    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGHUP, on_signal);

    dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fprintf(stderr, "record-stream-helper: cannot open X display\n");
        return 1;
    }
    screen = DefaultScreen(dpy);
    root = RootWindow(dpy, screen);
    if (first_monitor_geometry(dpy, screen, &geo) < 0) {
        fprintf(stderr, "record-stream-helper: cannot resolve first monitor geometry\n");
        XCloseDisplay(dpy);
        return 1;
    }

    pixel = alloc_indicator_color(dpy, screen);
    for (int i = 0; i < 4; ++i) {
        border[i] = create_overlay_window(dpy, root, 0, 0, 2, 2, pixel);
        if (!border[i]) {
            fprintf(stderr, "record-stream-helper: failed to create outline window\n");
            running = 0;
            exit_status = 1;
            break;
        }
    }
    if (running) {
        position_border_windows(dpy, border, DisplayWidth(dpy, screen), DisplayHeight(dpy, screen), &geo);
        XFlush(dpy);
        if (start_ffmpeg(&opts, &geo) < 0) {
            fprintf(stderr, "record-stream-helper: failed to start ffmpeg: %s\n", strerror(errno));
            running = 0;
            exit_status = 1;
        }
    }

    while (running) {
        int status;
        if (opts.parent_pid > 1 && kill(opts.parent_pid, 0) < 0 && errno == ESRCH) {
            running = 0;
            break;
        }
        while (XPending(dpy) > 0) {
            XEvent ev;
            XNextEvent(dpy, &ev);
            if (ev.type == Expose)
                XClearWindow(dpy, ev.xexpose.window);
        }
        if (ffmpeg_pid > 0) {
            pid_t waited = waitpid(ffmpeg_pid, &status, WNOHANG);
            if (waited == ffmpeg_pid) {
                ffmpeg_pid = -1;
                if (WIFEXITED(status))
                    exit_status = WEXITSTATUS(status);
                else if (WIFSIGNALED(status))
                    exit_status = 128 + WTERMSIG(status);
                running = 0;
            }
        }
        usleep(50000);
    }

    if (ffmpeg_pid > 0) {
        int status;
        kill(ffmpeg_pid, SIGTERM);
        for (int i = 0; i < 30; ++i) {
            if (waitpid(ffmpeg_pid, &status, WNOHANG) == ffmpeg_pid) {
                ffmpeg_pid = -1;
                break;
            }
            usleep(50000);
        }
        if (ffmpeg_pid > 0) {
            kill(ffmpeg_pid, SIGKILL);
            waitpid(ffmpeg_pid, NULL, 0);
            ffmpeg_pid = -1;
        }
    }

    for (int i = 0; i < 4; ++i) {
        if (border[i])
            XDestroyWindow(dpy, border[i]);
    }
    XCloseDisplay(dpy);
    return exit_status;
}
