# Gluetun Port Manager

Inspired by [SnoringDragon](https://github.com/SnoringDragon/gluetun-qbittorrent-port-manager/).

## Description

Watches for changes in the port forwarded by [gluetun](https://github.com/qdm12/gluetun), and notifies an application
of the changed port.

## Usage

```env
# the path to the file where the open port is written to by gluetun
PORT_CHANGE_FILE=/path/to/file
# the host where your application is running
GTPM_APPLICATION_HOST=qbit.example.com
# the username for your application
GTPM_APPLICATION_USERNAME=admin
# the password for your application
GTPM_APPLICATION_PASSWORD=password
# whether to use https or not (any value will do)
GTPM_APPLICATION_SECURE=true
```

```bash
# pull the docker image
docker pull ghcr.io/mihirsamdarshi/gtpm:latest
# run the docker image
docker run -d \
  --name=qbpm \
  --restart=unless-stopped \
  -e PORT_CHANGE_FILE=/path/to/file \
  -e GTPM_APPLICATION_HOST=qbit.example.com \
  -e GTPM_APPLICATION_USERNAME=admin \
  -e GTPM_APPLICATION_PASSWORD=password \
  -e GTPM_APPLICATION_SECURE=true \
  ghcr.io/mihirsamdarshi/qbpm:latest
```
