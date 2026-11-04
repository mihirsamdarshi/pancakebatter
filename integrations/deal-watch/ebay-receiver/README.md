# Deal Watch eBay receiver

Answers eBay's Marketplace Account Deletion challenge, verifies and durably records notifications
(ids and times only), and publishes `/state` for the worker. See the persistent eBay design.

## Notes

- Forged key ids can use up the budget of 6 key lookups an hour, so a genuinely new eBay key may
  wait up to an hour. Cached keys keep working.
- The volume is checked only at start. A volume lost while the pod runs is noticed at the next restart.
- A verified notification is always acknowledged with 200, whatever its topic or shape. Odd ones log
  a fixed reason code only (`notification-accepted-odd`).
- The rate bucket covers challenge GETs only. POSTs are bounded by the in-flight, connection and key-lookup caps.
