# xattr 0.2.3 compatibility patch

Source: crates.io xattr 0.2.3, https://github.com/Stebalien/xattr.
Original MIT and Apache licenses are preserved alongside the source.

GPUI 0.2.2 -> gpui_http_client 0.2.2 -> zed-async-tar 0.5.0-zed
depends on this old API. Linux native CI failed because recent libc releases
removed the deprecated ENOATTR alias on Linux and Android. Those platforms use
ENODATA; macOS and BSD retain ENOATTR.

The only source change is the platform constant selection in src/sys/mod.rs.
Remove this patch when GPUI's archive dependency uses a maintained xattr release.
Do not downgrade libc globally to preserve a removed compatibility alias.
