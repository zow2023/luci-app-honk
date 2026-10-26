#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAKEFILE="$REPO_DIR/honk/Makefile"
UPSTREAM_REPO="daeuniverse/honk"

# 官方 debug 滚动构建 tag 形如 debug.2026.10.21.1
DEBUG_TAG_RE='^debug\.[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$'
# 新预发布线 tag 形如 v0.1.0-beta.2
BETA_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$'
# 正式版 tag 宽松白名单: 可选 v/V 前缀 + 数字主段 + 任意非空后缀段
# (精细解析交给 derive_version, 这里只做 "能否安全进 sed" 的闸门)
RELEASE_TAG_RE='^[vV]?[0-9]+(\.[0-9]+)*([-_.][A-Za-z0-9._-]+)*$'

git_ls_remote() {
    local attempt
    for attempt in 1 2 3 4 5; do
        if git ls-remote --tags "https://github.com/${UPSTREAM_REPO}.git" 2>/dev/null; then
            return 0
        fi
        sleep 3
    done
    return 1
}

calc_sha256() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        echo "error: neither sha256sum nor shasum is installed" >&2
        return 1
    fi
}

# 产出两个值:
#   PKG_VERSION    -- OpenWrt 版本号
#   ASSET_TAG      -- Makefile 里 HONK_ASSET_TAG 的取值
#   (debug 构建资产名固定为 honk-core-debug-..., 故 ASSET_TAG=debug;
#    正式版资产名内嵌完整 tag, 故 ASSET_TAG=tag 本身)
derive_version() {
    local tag="$1"
    local v="${tag#[vV]}"

    # ---- [debug 分支] debug.2026.10.21.1 ----
    # PKG_VERSION = 2026.10.21.1_pre1
    #   纯数字主段 + _pre1 后缀, apk/opkg 均合法;
    #   日序号编码在第四数字段, _pre1 为固定后缀 (不随序号变),
    #   故 debug.2026.10.21.2 -> 2026.10.21.2_pre1 > 2026.10.21.1_pre1, 保序。
    #   注意: _pre1 使 debug 版永远 < 同数字无后缀版本 (apk 语义
    #   2026.10.21.1_pre1 < 2026.10.21.1), 即 debug 与正式版共享版本空间时, 正式版被视为"更新"。
    # ASSET_TAG   = debug
    if printf '%s' "$tag" | grep -qE "$DEBUG_TAG_RE"; then
        printf '%s\n' "$tag" \
            | sed -E 's/^debug\.([0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+)$/\1_pre1/'
        printf 'debug\n'
        return 0
    fi

    # ---- [正式版分支] v0.0.1.beta.84 / v0.1.0-beta.2 ----
    # v0.0.1.beta.84 -> PKG_VERSION = 0.0.1_beta84, ASSET_TAG = v0.0.1.beta.84
    # v0.1.0-beta.2  -> PKG_VERSION = 0.1.0_beta2,  ASSET_TAG = v0.1.0-beta.2
    local prefix rest stage stage_num patch_num
    stage=""
    stage_num=""
    patch_num=""

    prefix="$(printf '%s' "$v" | sed -E 's/^([0-9]+(\.[0-9]+)*).*/\1/')"
    [ -n "$prefix" ] || prefix="0.0.0"

    rest="${v#"$prefix"}"
    rest="$(printf '%s' "$rest" | sed -E 's/^[-_.]+//')"

    if [ -n "$rest" ]; then
        rest="$(printf '%s' "$rest" | tr '[:upper:]' '[:lower:]')"

        if printf '%s' "$rest" | grep -qE '^(alpha|beta|pre|rc|cvs|git|hg|svn)'; then
            stage="$(printf '%s' "$rest" | sed -E -n 's/^(alpha|beta|pre|rc|cvs|git|hg|svn).*/\1/p')"
            rest="$(printf '%s' "$rest" | sed -E 's/^(alpha|beta|pre|rc|cvs|git|hg|svn)//' | sed -E 's/^[-_.]+//')"

            stage_num="$(printf '%s' "$rest" | sed -E -n 's/^([0-9]+).*/\1/p')"
            if [ -n "$stage_num" ]; then
                rest="${rest#"$stage_num"}"
                rest="$(printf '%s' "$rest" | sed -E 's/^[-_.]+//')"
            fi
        fi

        if [ -n "$rest" ]; then
            rest="$(printf '%s' "$rest" | sed -E 's/[-_.]//g')"
            if printf '%s' "$rest" | grep -qE '^(fix)+$'; then
                local orig_len="${#rest}"
                local stripped_rest="${rest//fix/}"
                patch_num=$(( (orig_len - ${#stripped_rest}) / 3 ))
            elif printf '%s' "$rest" | grep -qE '^(fix|patch|hotfix|p)[0-9]+'; then
                patch_num="$(printf '%s' "$rest" | sed -E -n 's/^(fix|patch|hotfix|p)([0-9]+).*/\2/p')"
            elif printf '%s' "$rest" | grep -qE '^(fix|patch|hotfix|p)$'; then
                patch_num="1"
            fi
        fi
    fi

    local result="$prefix"
    [ -z "$stage" ] || result="${result}_${stage}${stage_num}"
    [ -z "$patch_num" ] || result="${result}_p${patch_num}"

    printf '%s\n' "$result"
    printf '%s\n' "$tag"
}

assert_apk_version() {
    local v="$1"

    if command -v apk >/dev/null 2>&1; then
        apk version -c "$v" >/dev/null 2>&1 && return 0 || return 1
    fi

    local apk_regex="^[0-9]+(\.[0-9]+)*[a-z]?(_(alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*$"
    if ! printf '%s' "$v" | grep -qE "$apk_regex"; then
        if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
            docker run --rm alpine apk version -c "$v" >/dev/null 2>&1 && return 0 || return 1
        fi
        return 1
    fi

    return 0
}

# 入口闸门: 校验 tag 是否可安全用于 sed 替换段与下载 URL。
# 语义上接受三类: 官方 debug 滚动 tag, v0.1.0-beta.N 新预发布线,
# 或形如 v0.0.1.beta.84 的正式版 tag。
# 任何含 sed 元字符 (&、\) 或路径分隔符 (/) 的值在此处 fail-fast。
assert_safe_tag() {
    local tag="$1"
    printf '%s' "$tag" | grep -qE "$DEBUG_TAG_RE" && return 0
    printf '%s' "$tag" | grep -qE "$BETA_TAG_RE" && return 0
    printf '%s' "$tag" | grep -qE "$RELEASE_TAG_RE" && return 0
    return 1
}

resolve_tag() {
    # 优先级 1: workflow 注入的、已在 yml 层按白名单正则过滤过的 tag
    if [ -n "${HONK_TAG_OVERRIDE:-}" ]; then
        printf '%s\n' "$HONK_TAG_OVERRIDE"
        return 0
    fi

    # 优先级 2: 兼容旧变量名
    if [ -n "${HONK_RELEASE_TAG:-}" ]; then
        printf '%s\n' "$HONK_RELEASE_TAG"
        return 0
    fi

    # 优先级 3: GitHub API 列表端点 + 白名单正则过滤。
    # 不能用 /releases/latest -- debug 构建是 prerelease, 该端点永远跳过。
    # 上游 release 频繁, per_page 提到 100, 防止久未更新的线被挤出首页。
    local json tag
    json="$(curl -fsSL --retry 3 --connect-timeout 15 \
        "https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=100" 2>/dev/null || true)"

    if [ -n "$json" ]; then
        tag="$(printf '%s' "$json" \
            | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
            | sed -E 's/^"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)"$/\1/' \
            | grep -E "${DEBUG_TAG_RE}|${BETA_TAG_RE}" | head -n 1 || true)"
        if [ -n "$tag" ]; then
            printf '%s\n' "$tag"
            return 0
        fi
    fi

    # 优先级 4: ls-remote 兜底 (同样按白名单正则过滤)
    git_ls_remote | awk '{print $2}' | sed 's|refs/tags/||' \
        | grep -v '\^{}' | grep -E "${DEBUG_TAG_RE}|${BETA_TAG_RE}" \
        | sort -V | tail -n 1 || true
}

# $1 = asset_tag, $2 = target, $3 = allocator suffix (-stock 或空),
# $4 = API variant (-native-api/-full/-clash-api 或空), $5 = tag (仅用于 URL 路径)
resolve_hash() {
    local asset_tag="$1"
    local target="$2"
    local suffix="$3"
    local variant="$4"
    local tag="$5"
    local asset="honk-core-${asset_tag}-${target}${suffix}${variant}.tar.gz"

    local tmp hash
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' RETURN

    if ! curl -fsSL --retry 3 --connect-timeout 20 \
        "https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/${asset}" -o "$tmp" 2>/dev/null; then
        rm -f "$tmp"
        echo "error: unable to download ${asset} (tag=${tag})" >&2
        echo "hint: debug 发布非原子性, 若发布正在进行中可稍后重试; CI 层可依赖 workflow 自动重跑" >&2
        return 1
    fi

    if ! hash="$(calc_sha256 "$tmp")"; then
        rm -f "$tmp"
        echo "error: unable to hash ${asset}" >&2
        return 1
    fi
    rm -f "$tmp"

    printf '%s\n' "$hash"
}

main() {
    local tag version asset_tag suffix variant hash_x86_64 hash_aarch64

    # resolve_tag 兜底链整体失败时 (含 pipefail 传播的非零码) 不让 set -e
    # 在赋值处杀掉脚本, 统一走下方非空校验的友好报错出口。
    tag="$(resolve_tag || true)"
    [ -n "$tag" ] || { echo "error: unable to resolve honk release tag" >&2; exit 1; }

    # 入口闸门: 无论 tag 来自环境变量还是自动解析, 不在白名单内一律拒绝,
    # 防止 sed 元字符 / 路径分隔符注入后续替换段与下载 URL。
    if ! assert_safe_tag "$tag"; then
        echo "error: refusing unsafe or unrecognized tag '${tag}'" >&2
        exit 1
    fi

    # derive_version 输出两行: PKG_VERSION, ASSET_TAG
    local derived
    derived="$(derive_version "$tag")"
    version="$(printf '%s\n' "$derived" | sed -n 1p)"
    asset_tag="$(printf '%s\n' "$derived" | sed -n 2p)"

    if ! assert_apk_version "$version"; then
        echo "WARNING: Parsed version '${version}' is invalid for apk-tools!" >&2
        # fallback 先剥掉非数字前缀 (如 debug.), 再取数字段
        version="$(printf '%s' "$tag" | sed -E 's/^[^0-9]*//' | sed -E 's/^([0-9]+(\.[0-9]+)*).*/\1/')"
        [ -n "$version" ] || version="0.0.0"
        echo "INFO: Falling back to strict safe PKG_VERSION='${version}'" >&2
    else
        echo "INFO: Validated PKG_VERSION='${version}'" >&2
    fi

    # 出口闸门: 任何原因导致版本号不以数字开头, 直接失败退出,
    # 绝不把非法值写进 Makefile。
    case "$version" in
        [0-9]*) : ;;
        *)
            echo "error: PKG_VERSION '${version}' does not start with a digit; refusing to write Makefile" >&2
            exit 1
            ;;
    esac

    # 读取双变量 (由 update workflow 探测上游资产名后写入):
    #   HONK_SUFFIX  -- 分配器段, -stock 或空 (mimalloc)
    #   HONK_VARIANT -- API 段, -native-api/-full/-clash-api 或空 (debug 旧线)
    # 剥离行内注释与所有空白, 避免把注释文本带进资产下载 URL。
    suffix="$(grep '^HONK_SUFFIX:=' "$MAKEFILE" | head -n 1 | cut -d= -f2- \
        | sed -E 's/[#].*$//' | tr -d '[:space:]' || true)"
    variant="$(grep '^HONK_VARIANT:=' "$MAKEFILE" | head -n 1 | cut -d= -f2- \
        | sed -E 's/[#].*$//' | tr -d '[:space:]' || true)"

    echo "INFO: asset segments: suffix='${suffix}' variant='${variant}'" >&2

    hash_x86_64="$(resolve_hash "$asset_tag" "x86_64-unknown-linux-musl" "$suffix" "$variant" "$tag")"
    hash_aarch64="$(resolve_hash "$asset_tag" "aarch64-unknown-linux-musl" "$suffix" "$variant" "$tag")"

    sed -E \
        -e "s/^PKG_VERSION:=.*/PKG_VERSION:=${version}/" \
        -e "s/^HONK_RELEASE_TAG:=.*/HONK_RELEASE_TAG:=${tag}/" \
        -e "s/^HONK_ASSET_TAG:=.*/HONK_ASSET_TAG:=${asset_tag}/" \
        -e "s/^HONK_HASH_X86_64:=.*/HONK_HASH_X86_64:=${hash_x86_64}/" \
        -e "s/^HONK_HASH_AARCH64:=.*/HONK_HASH_AARCH64:=${hash_aarch64}/" \
        "$MAKEFILE" > "${MAKEFILE}.tmp"

    mv "${MAKEFILE}.tmp" "$MAKEFILE"

    echo "==================================="
    echo "honk updated to ${tag} (PKG_VERSION=${version}, HONK_ASSET_TAG=${asset_tag})"
    echo "HONK_SUFFIX='${suffix}' HONK_VARIANT='${variant}'"
    echo "HONK_HASH_X86_64=${hash_x86_64}"
    echo "HONK_HASH_AARCH64=${hash_aarch64}"
}

main "$@"
