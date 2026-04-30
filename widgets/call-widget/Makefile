CC ?= cc
PKG_CONFIG ?= pkg-config
CFLAGS ?= -O2 -Wall -Wextra -std=c11
PKGS = x11 xrender cairo cairo-xlib pangocairo gdk-pixbuf-2.0 glib-2.0 libcurl json-c
TARGET = record-call-widget

PKG_CFLAGS := $(shell $(PKG_CONFIG) --cflags $(PKGS))
PKG_LIBS := $(shell $(PKG_CONFIG) --libs $(PKGS))

.PHONY: all clean

all: $(TARGET)

$(TARGET): record-call-widget.c
	$(CC) $(CFLAGS) $(PKG_CFLAGS) $< -o $@ $(PKG_LIBS) -lm

clean:
	rm -f $(TARGET)
