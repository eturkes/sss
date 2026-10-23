#!/bin/sh
set -eu

: "${SSS_PLAYWRIGHT_EXECUTABLE:?SSS requires the bundled Chromium executable}"
: "${SSS_PARENT_NETWORK_NAMESPACE:?SSS requires the parent network namespace}"

profile=
for argument do
  case "$argument" in
    --user-data-dir=*) profile=${argument#--user-data-dir=} ;;
  esac
done
case "$profile" in
  /*) ;;
  *) echo 'SSS requires an absolute temporary Chromium profile' >&2; exit 1 ;;
esac
[ -d "$profile" ] || { echo 'SSS requires an existing temporary Chromium profile' >&2; exit 1; }
command -v bwrap >/dev/null 2>&1 || { echo 'SSS requires bubblewrap (bwrap) and Linux network namespaces' >&2; exit 1; }

# The browser writes to its fresh profile and private devices; Playwright's control pipes remain open.
exec bwrap --unshare-net --die-with-parent --ro-bind / / --dev /dev --proc /proc \
  --bind "$profile" "$profile" --setenv HOME "$profile" --setenv TMPDIR "$profile" \
  --setenv XDG_CONFIG_HOME "$profile/config" --setenv XDG_CACHE_HOME "$profile/cache" \
  -- /bin/sh -eu -c '
    current=$(readlink /proc/self/ns/net)
    [ "$current" != "$SSS_PARENT_NETWORK_NAMESPACE" ] || { echo "SSS browser network namespace was not isolated" >&2; exit 1; }
    exec "$SSS_PLAYWRIGHT_EXECUTABLE" "$@"
  ' -- "$@"
