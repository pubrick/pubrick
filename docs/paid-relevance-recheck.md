# Paid relevance recheck

The Sources screen separates **Update rankings** (local feedback adjustment,
no model call) from **Paid AI recheck** (a fresh advisory model verdict). Only
workspace owners and admins can start a paid batch. The default lookback is
seven days; the API accepts one to 30 days. A preview counts at most 501 rows
so it can say when the newest 500 cap applies. Admission freezes at most the
previewed count of already scored stories. Each selected article has one durable
work row and one queue job created in the same transaction as the batch.

The preview shows a *planning estimate* from the selected model's current
price table, assuming 3,000 input and 500 output tokens per verdict. It is
not a dollar limit: real prompts, provider billing, and optional Google
embeddings vary. Unknown/custom model rates remain unknown. The hard call
ceiling is one model verdict and one optional embedding call per article,
at most 500 of each. Jobs have no automatic retry. The usage ledger records
each physical call before a result advances progress; if that write fails, the
batch records an unrecorded-call count before progress advances and the UI
marks displayed spend incomplete. A failed recheck leaves
the prior article verdict unchanged.

The batch and each article's result are tenant scoped. A partial unique index
prevents overlapping paid batches for one brand. Invalid or unreadable keys
and unknown models stop the batch after the first terminal
failure; remaining queued articles are marked skipped. Other failures are
counted per article. The UI polls the latest batch and shows updated, failed,
and skipped counts. It never receives raw provider error text or credentials.

An expired or crashed job is sent to the dead-letter queue and marked failed;
an indexed five-minute repair scan also closes work whose original queue job
is terminal or missing after a failed dead-letter handler. There is no implicit
paid replay. If a worker dies immediately after a provider charges a call,
the call and its usage may be unknown because no ledger write completed. To
try again, an owner/admin starts a new explicit batch after reviewing the new
preview. That may pay for the same article again.
