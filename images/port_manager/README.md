# Gluetun Port Manager

Inspired by [SnoringDragon](https://github.com/SnoringDragon/gluetun-qbittorrent-port-manager/).

This assumes that you have both [angel-nu's pod-gateway](https://github.com/angelnu/pod-gateway)
and [gluetun](https://github.com/qdm12/gluetun) running in Kubernetes.

## Description

Watches for changes in the port forwarded by [gluetun](https://github.com/qdm12/gluetun), and notifies an application
of the changed port.

## Usage

The application is configured using environment variables.

### Environment variables

| Environment variable        | Default                             | Description                                                       |
|-----------------------------|-------------------------------------|-------------------------------------------------------------------|
| `PORT_CHANGE_FILE`          | None                                | The path to the file where the open port is written to by gluetun |
| `GTPM_APPLICATION_HOST`     | None                                | The host where your application is running                        |
| `GTPM_APPLICATION_USER`     | None                                | The username for your application                                 |
| `GTPM_APPLICATION_PASSWORD` | None                                | The password for your application                                 |
| `GTPM_APPLICATION_SECURE`   | `false` (empty)                     | Whether to use https or not (any value will do)                   |
| `GTPM_APPLICATION_PORT`     | 443 if secure^ is set, 80 otherwise | Whether to use https or not (any value will do)                   |
| `GTPM_NAT_CONF_FILE`        | `/config/nat.conf`                  | The nat.conf file used by Pod Gateway                             |
| `GTPM_SETTINGS_FILE`        | `/config/settings.sh`               | The settings.sh file used by Pod Gateway                          |

```bash
# pull the docker image
docker pull ghcr.io/mihirsamdarshi/pancakebatter/gtpm:latest
# run the docker image
docker run -d \
  --name=qbpm \
  --restart=unless-stopped \
  -e PORT_CHANGE_FILE=/path/to/file \
  -e GTPM_APPLICATION_HOST=qbit.example.com \
  -e GTPM_APPLICATION_USERNAME=admin \
  -e GTPM_APPLICATION_PASSWORD=password \
  -e GTPM_APPLICATION_SECURE=true \
  ghcr.io/mihirsamdarshi/pancakebatter/gtpm:latest
```
