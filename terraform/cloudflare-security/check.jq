[ (.resource_changes // [])[]
  | select(.change.actions | index("delete")),
    ( select(.type=="cloudflare_ruleset" and (.change.actions|index("no-op")|not))
      | ((.change.before.rules // []) as $b | (.change.after.rules // []) as $a
         | $b[] | . as $o | ($o.ref // $o.id) as $r
         | select($r != "flux_webhook_github_only")
         | select(($a|map(select(.ref==$r))|first) as $n
             | $n==null or $n.expression!=$o.expression or $n.action!=$o.action
               or ($n.enabled//true)!=($o.enabled//true))) ) ] | length==0
