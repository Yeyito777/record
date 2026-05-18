CC ?= cc
PKG_CONFIG ?= pkg-config
CFLAGS ?= -O2 -Wall -Wextra -std=c11
PKGS = x11 xext xinerama
TARGET = record-stream-helper

PKG_CFLAGS := $(shell $(PKG_CONFIG) --cflags $(PKGS) 2>/dev/null)
PKG_LIBS := $(shell $(PKG_CONFIG) --libs $(PKGS) 2>/dev/null || echo -lX11 -lXext -lXinerama)

.PHONY: all clean

all: $(TARGET)

$(TARGET): record-stream-helper.c
	$(CC) $(CFLAGS) $(PKG_CFLAGS) $< -o $@ $(PKG_LIBS)

clean:
	rm -f $(TARGET)
