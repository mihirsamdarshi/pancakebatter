#!/bin/bash

# Get the list of PVs
pvs=$(kubectl get pv -o name | grep "persistentvolume/pvc-*" | sed -E 's/persistentvolume\///g')

# For each PV, change the reclaim policy to "Retain"
for pv in $pvs; do
  echo $pv

  kubectl patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
done
#

