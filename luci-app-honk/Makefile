# SPDX-License-Identifier: Apache-2.0
#
# Copyright (C) 2026 luci-app-honk maintainers

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-honk
PKG_VERSION:=1.0.0
PKG_RELEASE:=3

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=luci-app-honk maintainers

LUCI_TITLE:=LuCI support for honk
LUCI_PKGARCH:=all
LUCI_DEPENDS:=+honk

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
