# Deal Watch integrations

**Activation proposal:** encrypted credentials and the pinned image are included.
Do not merge or apply before complete validation, independent review and
owner activation approval.

Proposed activation of the reviewed external worker; merging deploys one
restricted worker in its own namespace. This is outside the personal app
platform. It mounts the shopping webhook and watch policy from SOPS-encrypted Secrets
and uses a separate SOPS-encrypted read-only GHCR credential. Mounted files
contain decrypted values and are accessible only inside the worker pod. The Flux object lives in
flux-system and reads its existing domain substitution there; no copy of
cluster-secrets is added to the worker namespace.

The image pins the checked revision published by PR #773. The credential
rollout checksum is calculated from the encrypted credential file, never the
private policy fingerprint. Policy agreement is checked inside the worker.

Initial coverage is Sony only, no faster than one check every two minutes.
Costco, Best Buy, Target and eBay remain disabled. This starts continuous
collection and qualifying-offer Discord delivery; it does not buy anything.
No caller-facing Service/route, browser runtime, PVC or API token is added.

Before merging, the owner must approve this activation, the bounded live
network/containment checks and a clearly labeled shopping-channel test.
Automatic first-source collection and qualifying alerts begin after startup.
Backup/export and deployment availability alerts remain on the dashboard.
Rollback or retirement requires a separate explicit go.
