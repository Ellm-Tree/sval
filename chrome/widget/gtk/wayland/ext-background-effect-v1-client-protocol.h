/* In the form wayland-scanner 1.23.1 generates from ext-background-effect-v1.xml
 * in wayland-protocols, staging. */

#ifndef EXT_BACKGROUND_EFFECT_V1_CLIENT_PROTOCOL_H
#define EXT_BACKGROUND_EFFECT_V1_CLIENT_PROTOCOL_H

#include <stdint.h>
#include <stddef.h>
#include "wayland-client.h"

#ifdef __cplusplus
extern "C" {
#endif


/*
 * Copyright (C) 2015 Martin Gräßlin
 * Copyright (C) 2015 Marco Martin
 * Copyright (C) 2020 Vlad Zahorodnii
 * Copyright (C) 2024 Xaver Hugl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice (including the next
 * paragraph) shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

struct ext_background_effect_manager_v1;
struct ext_background_effect_surface_v1;
struct wl_region;
struct wl_surface;

#ifndef EXT_BACKGROUND_EFFECT_MANAGER_V1_INTERFACE
#  define EXT_BACKGROUND_EFFECT_MANAGER_V1_INTERFACE
extern const struct wl_interface ext_background_effect_manager_v1_interface;
#endif
#ifndef EXT_BACKGROUND_EFFECT_SURFACE_V1_INTERFACE
#  define EXT_BACKGROUND_EFFECT_SURFACE_V1_INTERFACE
extern const struct wl_interface ext_background_effect_surface_v1_interface;
#endif

#ifndef EXT_BACKGROUND_EFFECT_MANAGER_V1_ERROR_ENUM
#  define EXT_BACKGROUND_EFFECT_MANAGER_V1_ERROR_ENUM
enum ext_background_effect_manager_v1_error {
  EXT_BACKGROUND_EFFECT_MANAGER_V1_ERROR_BACKGROUND_EFFECT_EXISTS = 0,
};
#endif /* EXT_BACKGROUND_EFFECT_MANAGER_V1_ERROR_ENUM */

#ifndef EXT_BACKGROUND_EFFECT_MANAGER_V1_CAPABILITY_ENUM
#  define EXT_BACKGROUND_EFFECT_MANAGER_V1_CAPABILITY_ENUM
enum ext_background_effect_manager_v1_capability {
  EXT_BACKGROUND_EFFECT_MANAGER_V1_CAPABILITY_BLUR = 1,
};
#endif /* EXT_BACKGROUND_EFFECT_MANAGER_V1_CAPABILITY_ENUM */

struct ext_background_effect_manager_v1_listener {
  void (*capabilities)(
      void* data,
      struct ext_background_effect_manager_v1* ext_background_effect_manager_v1,
      uint32_t flags);
};

static inline int ext_background_effect_manager_v1_add_listener(
    struct ext_background_effect_manager_v1* ext_background_effect_manager_v1,
    const struct ext_background_effect_manager_v1_listener* listener,
    void* data) {
  return wl_proxy_add_listener(
      (struct wl_proxy*)ext_background_effect_manager_v1,
      (void (**)(void))listener, data);
}

#define EXT_BACKGROUND_EFFECT_MANAGER_V1_DESTROY 0
#define EXT_BACKGROUND_EFFECT_MANAGER_V1_GET_BACKGROUND_EFFECT 1

#define EXT_BACKGROUND_EFFECT_MANAGER_V1_CAPABILITIES_SINCE_VERSION 1

#define EXT_BACKGROUND_EFFECT_MANAGER_V1_DESTROY_SINCE_VERSION 1
#define EXT_BACKGROUND_EFFECT_MANAGER_V1_GET_BACKGROUND_EFFECT_SINCE_VERSION 1

static inline void ext_background_effect_manager_v1_set_user_data(
    struct ext_background_effect_manager_v1* ext_background_effect_manager_v1,
    void* user_data) {
  wl_proxy_set_user_data((struct wl_proxy*)ext_background_effect_manager_v1,
                         user_data);
}

static inline void* ext_background_effect_manager_v1_get_user_data(
    struct ext_background_effect_manager_v1* ext_background_effect_manager_v1) {
  return wl_proxy_get_user_data(
      (struct wl_proxy*)ext_background_effect_manager_v1);
}

static inline uint32_t ext_background_effect_manager_v1_get_version(
    struct ext_background_effect_manager_v1* ext_background_effect_manager_v1) {
  return wl_proxy_get_version(
      (struct wl_proxy*)ext_background_effect_manager_v1);
}

static inline void ext_background_effect_manager_v1_destroy(
    struct ext_background_effect_manager_v1* ext_background_effect_manager_v1) {
  wl_proxy_marshal_flags(
      (struct wl_proxy*)ext_background_effect_manager_v1,
      EXT_BACKGROUND_EFFECT_MANAGER_V1_DESTROY, NULL,
      wl_proxy_get_version((struct wl_proxy*)ext_background_effect_manager_v1),
      WL_MARSHAL_FLAG_DESTROY);
}

static inline struct ext_background_effect_surface_v1*
ext_background_effect_manager_v1_get_background_effect(
    struct ext_background_effect_manager_v1* ext_background_effect_manager_v1,
    struct wl_surface* surface) {
  struct wl_proxy* id;

  id = wl_proxy_marshal_flags(
      (struct wl_proxy*)ext_background_effect_manager_v1,
      EXT_BACKGROUND_EFFECT_MANAGER_V1_GET_BACKGROUND_EFFECT,
      &ext_background_effect_surface_v1_interface,
      wl_proxy_get_version((struct wl_proxy*)ext_background_effect_manager_v1),
      0, NULL, surface);

  return (struct ext_background_effect_surface_v1*)id;
}

#ifndef EXT_BACKGROUND_EFFECT_SURFACE_V1_ERROR_ENUM
#  define EXT_BACKGROUND_EFFECT_SURFACE_V1_ERROR_ENUM
enum ext_background_effect_surface_v1_error {
  EXT_BACKGROUND_EFFECT_SURFACE_V1_ERROR_SURFACE_DESTROYED = 0,
};
#endif /* EXT_BACKGROUND_EFFECT_SURFACE_V1_ERROR_ENUM */

#define EXT_BACKGROUND_EFFECT_SURFACE_V1_DESTROY 0
#define EXT_BACKGROUND_EFFECT_SURFACE_V1_SET_BLUR_REGION 1

#define EXT_BACKGROUND_EFFECT_SURFACE_V1_DESTROY_SINCE_VERSION 1
#define EXT_BACKGROUND_EFFECT_SURFACE_V1_SET_BLUR_REGION_SINCE_VERSION 1

static inline void ext_background_effect_surface_v1_set_user_data(
    struct ext_background_effect_surface_v1* ext_background_effect_surface_v1,
    void* user_data) {
  wl_proxy_set_user_data((struct wl_proxy*)ext_background_effect_surface_v1,
                         user_data);
}

static inline void* ext_background_effect_surface_v1_get_user_data(
    struct ext_background_effect_surface_v1* ext_background_effect_surface_v1) {
  return wl_proxy_get_user_data(
      (struct wl_proxy*)ext_background_effect_surface_v1);
}

static inline uint32_t ext_background_effect_surface_v1_get_version(
    struct ext_background_effect_surface_v1* ext_background_effect_surface_v1) {
  return wl_proxy_get_version(
      (struct wl_proxy*)ext_background_effect_surface_v1);
}

static inline void ext_background_effect_surface_v1_destroy(
    struct ext_background_effect_surface_v1* ext_background_effect_surface_v1) {
  wl_proxy_marshal_flags(
      (struct wl_proxy*)ext_background_effect_surface_v1,
      EXT_BACKGROUND_EFFECT_SURFACE_V1_DESTROY, NULL,
      wl_proxy_get_version((struct wl_proxy*)ext_background_effect_surface_v1),
      WL_MARSHAL_FLAG_DESTROY);
}

static inline void ext_background_effect_surface_v1_set_blur_region(
    struct ext_background_effect_surface_v1* ext_background_effect_surface_v1,
    struct wl_region* region) {
  wl_proxy_marshal_flags(
      (struct wl_proxy*)ext_background_effect_surface_v1,
      EXT_BACKGROUND_EFFECT_SURFACE_V1_SET_BLUR_REGION, NULL,
      wl_proxy_get_version((struct wl_proxy*)ext_background_effect_surface_v1),
      0, region);
}

#ifdef __cplusplus
}
#endif

#endif
