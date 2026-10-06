# SPDX-License-Identifier: Apache-2.0
#
# Copyright (C) 2016 OpenWrt.org
# Copyright (C) 2026 luci-app-honk maintainers

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-honk
PKG_VERSION:=1.1.4
PKG_RELEASE:=5

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=luci-app-honk maintainers

LUCI_TITLE:=LuCI support for honk
LUCI_URL:=https://github.com/zow2023/luci-app-honk
LUCI_PKGARCH:=all

LUCI_DEPENDS:=+honk +luci-base +rpcd-mod-ucode +curl

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
