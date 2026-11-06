# Exit 0 (via `jq -e`) only when all three lists below are empty.
# 1. Any resource that is deleted (a replace includes a delete).
# 2. Any carried ruleset rule (every rule except the Flux one) that is removed
#    or changed (expression, action or enabled).
# 3. cloudflare_bot_management.this: any planned attribute change other than
#    fight_mode, or a create (it must be imported first). Each attribute is
#    compared before vs after. An attribute whose planned value is unknown
#    (after_unknown true, "known after apply") is computed by Cloudflare and
#    is skipped, because the plan cannot say it changes. A key missing on one
#    side counts as null, so null vs absent is not a change.
[ (.resource_changes // [])[]
  | select(.change.actions | index("delete")),
    ( select(.type=="cloudflare_ruleset" and (.change.actions|index("no-op")|not))
      | ((.change.before.rules // []) as $b | (.change.after.rules // []) as $a
         | $b[] | . as $o | ($o.ref // $o.id) as $r
         | select($r != "flux_webhook_github_only")
         | select(($a|map(select(.ref==$r))|first) as $n
             | $n==null or $n.expression!=$o.expression or $n.action!=$o.action
               or ($n.enabled//true)!=($o.enabled//true))) ),
    ( select(.type=="cloudflare_bot_management" and (.change.actions|index("no-op")|not))
      | if (.change.actions|index("create")) then "create"
        else (.change.before // {}) as $b | (.change.after // {}) as $a
          | (.change.after_unknown // {}) as $u
          | ((($b|keys) + ($a|keys)) | unique | map(select(. != "fight_mode")))[]
          | . as $k
          | select(($u[$k] // false) != true and ($b[$k] // null) != ($a[$k] // null))
        end )
] | length==0
