# SPDX-License-Identifier: AGPL-3.0-only

include $(TOPDIR)/rules.mk

PKG_NAME:=honk
# 由 scripts/update_honk_version.sh 自动写入并保持同步，勿手改。
# debug 构建: debug.2026.10.21.1 -> 2026.10.21.1_pre1
# 正式版本: v0.1.0-beta.2       -> 0.1.0_beta2
PKG_VERSION:=0.1.0_beta3
PKG_RELEASE:=1

# Raw upstream release tag. It keeps the dots in qualifiers (e.g. v0.0.1.beta.49)
# because that is what the GitHub release asset name uses.
HONK_RELEASE_TAG:=v0.1.0-beta.3

# Asset-name segment, kept in sync by scripts/update_honk_version.sh.
# debug 构建的资产名固定且不含版本号 -> 写 "debug";
# 正式版资产名内嵌完整 tag -> 写 tag 本身 (e.g. v0.1.0-beta.2)。
HONK_ASSET_TAG:=v0.1.0-beta.3

# Allocator segment, kept in sync by the update workflow.
# -stock = stockalloc (lower RSS high-water on small gateways);
# empty  = mimalloc (faster QUIC, higher peak RSS).
HONK_SUFFIX:=-stock

# Upstream API feature segment, kept in sync by the update workflow.
# v0.1.0-beta.* 的资产名在分配器段后多一个 API 段:
#   -native-api = 仅原生 API (最小体积, OpenWrt 网关推荐)
#   -full       = Clash API + 原生 API + 内嵌 doona UI (功能超集)
#   -clash-api  = 仅 Clash API
#   empty       = debug 旧线资产名没有 API 段 / mimalloc 旧命名。
# 注意: API 段是编译期开关, 选错变体会导致配置中的对应段启动失败。
HONK_VARIANT:=-native-api

# SHA256 of each release tarball, kept in sync by scripts/update_honk_version.sh.
# 注意: debug 构建为滚动覆盖发布，同 tag 下二进制可能被上游重建，
# hash 一律以脚本实测为准，不缓存。
HONK_HASH_X86_64:=c839b648a443abde8b9bbc8290ebc3c6cd6a5c3e579f391a79016304820354ff
HONK_HASH_AARCH64:=216ace91ba157f909fca2ecf1f3b33015251b9481382609542fc6907dd521602

PKG_LICENSE:=AGPL-3.0-only
PKG_LICENSE_FILE:=LICENSE
PKG_MAINTAINER:=luci-app-honk maintainers

ifeq ($(ARCH),x86_64)
  HONK_TARGET:=x86_64-unknown-linux-musl
  HONK_HASH:=$(HONK_HASH_X86_64)
else ifeq ($(ARCH),aarch64)
  HONK_TARGET:=aarch64-unknown-linux-musl
  HONK_HASH:=$(HONK_HASH_AARCH64)
endif

HONK_ASSET:=honk-core-$(HONK_ASSET_TAG)-$(HONK_TARGET)$(HONK_SUFFIX)$(HONK_VARIANT).tar.gz

PKG_SOURCE:=$(HONK_ASSET)
PKG_SOURCE_URL:=https://github.com/daeuniverse/honk/releases/download/$(HONK_RELEASE_TAG)/
PKG_HASH:=$(HONK_HASH)

include $(INCLUDE_DIR)/package.mk

define Package/honk
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=honk - eBPF transparent proxy engine (dae-compatible)
  URL:=https://github.com/daeuniverse/honk
  DEPENDS:=@(x86_64||aarch64) \
    +ca-bundle +ip-full \
    +kmod-sched-core +kmod-sched-bpf +kmod-veth +kmod-nft-queue \
    +v2ray-geoip +v2ray-geosite \
    +@KERNEL_XDP_SOCKETS \
    +HONK_USE_VMLINUX_BTF:vmlinux-btf
endef

define Package/honk/config
    choice
        prompt "BTF source for CO-RE"
        default HONK_USE_KERNEL_BTF
        depends on PACKAGE_honk

    config HONK_USE_KERNEL_BTF
        bool "Use kernel BTF (integrated)"
        depends on KERNEL_DEBUG_INFO_BTF

    config HONK_USE_VMLINUX_BTF
        bool "Use vmlinux-btf package"
    endchoice
endef

define Package/honk/conffiles
/etc/honk/config.dae
/etc/honk/config.d/
/etc/honk/state/
/etc/config/honk
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(TAR) -xzf $(DL_DIR)/$(PKG_SOURCE) -C $(PKG_BUILD_DIR) --strip-components=1
endef

define Build/Compile
	true
endef

define Package/honk/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/honk-core $(1)/usr/bin/honk-core

	$(INSTALL_DIR) $(1)/etc/honk/config.d
	$(INSTALL_CONF) $(CURDIR)/files/config.dae $(1)/etc/honk/config.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/node.dae $(1)/etc/honk/config.d/node.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/route.dae $(1)/etc/honk/config.d/route.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/dns.dae $(1)/etc/honk/config.d/dns.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/api.dae $(1)/etc/honk/config.d/api.dae

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(CURDIR)/files/honk.config $(1)/etc/config/honk

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(CURDIR)/files/honk.init $(1)/etc/init.d/honk
endef

$(eval $(call BuildPackage,honk))
