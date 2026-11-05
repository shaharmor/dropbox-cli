#!/bin/sh
# Installs the latest dropbox-cli release on macOS or Linux.
#
#   curl -fsSL https://github.com/shaharmor/dropbox-cli/releases/latest/download/install.sh | sh
#
# Installs to $DROPBOX_CLI_INSTALL_DIR (default: ~/.local/bin). Re-run to upgrade.
# Never uses sudo and never edits shell config files.
set -eu

RELEASES_URL="https://github.com/shaharmor/dropbox-cli/releases"
DOWNLOAD_URL="$RELEASES_URL/latest/download"

fail() {
  echo "dropbox-cli install: $*" >&2
  exit 1
}

main() {
  install_dir="${DROPBOX_CLI_INSTALL_DIR:-$HOME/.local/bin}"

  os_name=$(uname -s)
  arch_name=$(uname -m)
  case "$os_name" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) os="" ;;
  esac
  case "$arch_name" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) arch="" ;;
  esac
  if [ -z "$os" ] || [ -z "$arch" ]; then
    fail "unsupported platform $os_name/$arch_name. See $RELEASES_URL for available builds."
  fi
  # An x64 shell under Rosetta on Apple Silicon should still get the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  asset="dropbox-cli-$os-$arch"

  tmp_dir=$(mktemp -d)
  tmp_bin=""
  trap 'rm -rf "$tmp_dir"; [ -z "$tmp_bin" ] || rm -f "$tmp_bin"' EXIT
  trap 'exit 1' HUP INT TERM

  echo "Downloading $asset..."
  curl -fsSL -o "$tmp_dir/$asset" "$DOWNLOAD_URL/$asset" ||
    fail "failed to download $DOWNLOAD_URL/$asset"
  curl -fsSL -o "$tmp_dir/checksums.txt" "$DOWNLOAD_URL/checksums.txt" ||
    fail "failed to download $DOWNLOAD_URL/checksums.txt"

  expected=$(awk -v name="$asset" 'NF == 2 && $2 == name { print $1; exit }' "$tmp_dir/checksums.txt")
  [ -n "$expected" ] || fail "checksums.txt has no entry for $asset. See $RELEASES_URL"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp_dir/$asset" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp_dir/$asset" | awk '{ print $1 }')
  else
    fail "neither sha256sum nor shasum is available to verify the download"
  fi
  [ "$actual" = "$expected" ] ||
    fail "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."

  mkdir -p "$install_dir"
  tmp_bin="$install_dir/.dropbox-cli.tmp.$$"
  cp "$tmp_dir/$asset" "$tmp_bin"
  chmod 755 "$tmp_bin"
  mv -f "$tmp_bin" "$install_dir/dropbox-cli"
  tmp_bin=""

  version=$("$install_dir/dropbox-cli" --version)
  echo "Installed dropbox-cli $version to $install_dir/dropbox-cli"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      echo
      echo "$install_dir is not on your PATH."
      case "$(basename "${SHELL:-}")" in
        zsh) rc="~/.zshrc" ;;
        bash) if [ "$os" = darwin ]; then rc="~/.bash_profile"; else rc="~/.bashrc"; fi ;;
        fish)
          echo "Add this line to ~/.config/fish/config.fish:"
          echo
          echo "fish_add_path $install_dir"
          return
          ;;
        *) rc="~/.profile" ;;
      esac
      echo "Add this line to $rc:"
      echo
      echo "export PATH=\"$install_dir:\$PATH\""
      ;;
  esac
}

main "$@"
