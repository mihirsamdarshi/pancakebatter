#!/usr/bin/env bash
# shellcheck disable=SC2016 # the single-quoted scripts expand inside the pod
# Set or reset the login of Sonarr, Radarr or Prowlarr through the app's API.
# Usage: kubernetes/apps/media/set-login.sh sonarr|radarr|prowlarr
#
# Run it on its own line in a terminal; it prompts for the username and the
# password and asks you to confirm. The API key is read inside the pod and the
# password travels only over stdin, so neither ends up on a command line.
set -euo pipefail

case ${1:-} in
    sonarr) port=8989 api=v3 ;;
    radarr) port=7878 api=v3 ;;
    prowlarr) port=9696 api=v1 ;;
    *) echo "usage: $0 sonarr|radarr|prowlarr" >&2; exit 2 ;;
esac
app=$1

# Always this cluster's kubeconfig, never whatever context is the default.
repo=$(cd "$(dirname "$0")/../../.." && pwd)
export KUBECONFIG="$repo/kubeconfig"

# Prompts read the terminal, not stdin, so pasted text cannot answer them.
read -rp 'Username: ' U </dev/tty
read -rsp 'Password: ' P </dev/tty; echo
read -rsp 'Password again: ' P2 </dev/tty; echo
if [[ -z $U || -z $P ]]; then echo 'Username and password must not be empty.' >&2; exit 1; fi
if [[ $P != "$P2" ]]; then echo 'The passwords do not match.' >&2; exit 1; fi
read -rp "Set the $app login to user '$U'? [y/N] " ok </dev/tty
[[ $ok == [yY] ]] || { echo 'Nothing changed.'; exit 1; }

# The API key is read from the app container's environment, inside the pod.
config=$(kubectl -n media exec "deploy/$app" -c app -- env PORT="$port" API="$api" sh -c '
    key=$(printenv | sed -n "s/^[A-Z]*__AUTH__APIKEY=//p")
    curl -fsS -H "X-Api-Key: $key" "http://127.0.0.1:$PORT/api/$API/config/host"')
id=$(jq -r .id <<<"$config")
export U P
jq '.username = env.U | .password = env.P | .passwordConfirmation = env.P' <<<"$config" |
    kubectl -n media exec -i "deploy/$app" -c app -- env PORT="$port" API="$api" ID="$id" sh -c '
        key=$(printenv | sed -n "s/^[A-Z]*__AUTH__APIKEY=//p")
        curl -fsS -o /dev/null -w "%{http_code}\n" -X PUT -d @- \
            -H "X-Api-Key: $key" -H "Content-Type: application/json" \
            "http://127.0.0.1:$PORT/api/$API/config/host/$ID"' |
    {
        read -r code
        if [[ $code != 202 ]]; then echo "Unexpected HTTP $code" >&2; exit 1; fi
        echo "Done: sign in to $app as '$U'."
    }
unset U P P2
