const gallery = [
  'added a consensus mode becacuse there was just one time the ai hallucinat even with my prompt enginerring(notice it capture the speed of the ai response).png',
  'bundled failed twice and the ai retried, it its submited succcessfully.png',
  'consensus mode activated, which each slot leader validator. Saw Jupiter hence why i capture it.png',
  'jito couldnt retur the exact reason why it fails, we go again (Day 6).png',
  'Leader skipp and it decided to retry for this bundle by default, it leader skiping only informs its decision.png',
  'showing upcoming leader state and the first count i saw when i switch to testnet.png',
  'The last day i stopeed getting console logs and focus mainly on the UI.png',
  'tricked the code to send a trassaction that doesnt it, the logic itself didnt process the transcation bundle ending.png',
  'tricked the code to send a trassaction that doesnt it, the logic itself didnt process the transcations ending.png',
  'Trying to find the middle ground for the pulse score calculation, tips balnce recomendation, and other logic.png'
];

const lifecycleRows = [
  ['2026-06-28 12:28:07', '472551833', 'submitted', 'p50 retry bundle', '3,557', 'BUNDLE_FAILURE_ATOMIC', 'Invalidated by Jito; retry loop used fresh blockhash and market tip context.'],
  ['2026-06-28 12:28:19', '472551864', 'submitted', 'retry attempt', '3,557', 'BUNDLE_FAILURE_ATOMIC', 'Bundle no longer in Jito system. Classified atomic because user transfer did not execute.'],
  ['2026-06-28 12:28:34', '472551903', 'submitted', 'retry attempt', '4,480', 'BUNDLE_FAILURE_ATOMIC', 'AI lifted tip under continued invalid status and healthy pulse.'],
  ['2026-06-28 12:28:50', '472551943', 'submitted', 'retry attempt', '4,480', 'BUNDLE_FAILURE_ATOMIC', 'Repeated invalid showed need for retry budget and richer diagnosis.'],
  ['2026-06-28 12:29:04', '472551975', 'submitted', 'retry attempt', '3,431', 'BUNDLE_FAILURE_ATOMIC', 'AI treated invalid as transient, but this later motivated chain-context enrichment.'],
  ['2026-06-28 12:29:05', '472551977', 'submitted', 'p90 retry', '10,126', 'BUNDLE_FAILURE_ATOMIC', 'Tip raised to p90 under competitive market.'],
  ['2026-06-28 12:29:06', '472551979', 'submitted', 'retry attempt', '3,431', 'BUNDLE_FAILURE_ATOMIC', 'Failure persisted despite healthy pulse, exposing Jito/testnet ambiguity.'],
  ['2026-06-29 04:20:39', '429593096', 'submitted', 'SOL transfer bundle', '2,043', 'BUNDLE_FAILURE_ATOMIC', 'Jito returned Failed with no specific reason. Diagnostic AI selected p90 retry.'],
  ['2026-06-29 10:21:22', '429646450', 'submitted', 'AI-timed SOL transfer', '2,354', 'BUNDLE_FAILURE_ATOMIC / Invalid', 'AI first held for 5 slots, then submitted at median tip; Jito later marked Invalid.'],
  ['2026-06-29 10:21:32', '429646475', 'submitted', 'diagnostic retry', '8,684', 'BUNDLE_FAILURE_ATOMIC / Invalid', 'Retry used p90 tip and fresh blockhash; still invalid.'],
  ['2026-06-29 10:21:44', '429646504', 'submitted', 'diagnostic retry', '8,684', 'none', 'Landed at slot 418565910 after two invalid attempts.'],
  ['2026-06-29 10:21:46', '418565910', 'processed', 'landed', '8,684', 'none', 'Processed delta from submission: 2,647ms.'],
  ['2026-06-29 10:21:48', '418565910', 'confirmed', 'confirmed', '8,684', 'none', 'Confirmed delta from submission: 4,876ms.'],
  ['2026-06-29 10:21:58', '418565910', 'finalized', 'finalized', '8,684', 'none', 'Finalized delta from submission: 14,873ms.']
];

const components = [
  ['SlotWatcher', 'Streams slots through Yellowstone gRPC first, then WSS, then HTTP polling. Resolves leader windows through RPC when gRPC emits slots before leader cache is ready.'],
  ['TipMonitor', 'Samples live Jito tip levels and keeps percentile context so tips are selected from observed market pressure, not hardcoded constants.'],
  ['PulseScore', 'Combines slot health, tip pressure, and leader reliability into one execution temperature. It is a decision input, not a magic truth source.'],
  ['AI Layer', 'Single-agent or consensus mode. Execution AI decides SUBMIT/HOLD; Diagnostic AI decides RETRY/SKIP only for real failed transaction payloads.'],
  ['BundleBuilder', 'Builds versioned SOL/SPL transfer bundles with Jito tip transfer included atomically. Every retry gets a fresh blockhash.'],
  ['JitoSubmitter', 'Submits bundles, tracks inflight status, follows landed bundles to confirmed/finalized, and enriches failures with chain context.'],
  ['StateManager', 'Maintains live network state, leader reliability, bundle lifecycle state, failed payload archive, and snapshot persistence.'],
  ['LifecycleLedger', 'Append-only JSONL audit log for decisions, holds, submissions, failures, transitions, and run summaries.']
];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow">Solana Testnet · Jito bundles · AI diagnostics</p>
          <h1>CHRONOS Observatory</h1>
          <p className="lede">
            A live transaction intelligence system that observes Solana conditions,
            times Jito bundle submission, explains failures, and retries only when
            the chain evidence says a real transaction failed.
          </p>
          <div className="heroStats">
            <span><b>62</b> submissions observed</span>
            <span><b>57</b> failures classified</span>
            <span><b>8,684</b> lamports finalized tip</span>
            <span><b>50</b> slot state window</span>
          </div>
        </div>
        <div className="terminal">
          <div className="terminalHeader">live operator trace</div>
          <code>[AI] HOLD 5 slots: slot health degraded, leader skips observed</code>
          <code>[Jito] Bundle accepted: 75e1042f...</code>
          <code>[Jito] INVALID: no longer in inflight system</code>
          <code>[Diag] collect signature, blockhash, balance, leader window</code>
          <code>[AI] RETRY with p90 tip: 8684 lamports</code>
          <code>[Jito] LANDED → CONFIRMED → FINALIZED</code>
        </div>
      </section>

      <section className="grid two">
        <Panel title="The Summary">
          <p>
            CHRONOS is not just a transaction sender. It is an execution observability
            loop: watch the network, score the moment, ask the AI whether to act,
            build a real Jito bundle, track the bundle lifecycle, then feed failures
            back with chain context.
          </p>
          <p>
            The important design choice is separation. Leader skips, tip spikes, and
            slow slots inform decisions, but they do not trigger fake retries. Only a
            failed bundle with a stored transaction payload can be retried.
          </p>
        </Panel>
        <Panel title="What Stands Out">
          <ul>
            <li>Detects leader window before submission instead of blindly sending.</li>
            <li>Uses live Jito tip percentiles for cost-aware priority.</li>
            <li>Tracks commitment progression: submitted, processed, confirmed, finalized.</li>
            <li>Classifies Jito `Failed`, `Invalid`, timeout, and on-chain execution failure.</li>
            <li>Enriches invalid failures with signature, blockhash, balance, and leader state.</li>
          </ul>
        </Panel>
      </section>

      <SectionTitle kicker="Architecture" title="System design and data flow" />
      <section className="architecture">
        <div className="flow">
          {['UI / EventBus', 'Slot + Tip Observers', 'State + Pulse Score', 'AI Decision Layer', 'Bundle Builder', 'Jito Submitter', 'Ledger + Snapshot'].map((item, index) => (
            <div className="flowNode" key={item}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              {item}
            </div>
          ))}
        </div>
        <div className="swimlane">
          <div>gRPC/WSS slots → leader cache → skipped leader memory</div>
          <div>Jito tips → p50/p90 pressure → tip recommendation</div>
          <div>Queued tx → AI HOLD/SUBMIT → bundle + fresh blockhash</div>
          <div>Invalid/Failed → chain context → Diagnostic AI RETRY/SKIP</div>
        </div>
      </section>

      <SectionTitle kicker="Components" title="Clean separation between AI, core stack, and failure handling" />
      <section className="componentGrid">
        {components.map(([name, body]) => (
          <article className="component" key={name}>
            <h3>{name}</h3>
            <p>{body}</p>
          </article>
        ))}
      </section>

      <SectionTitle kicker="Operational Evidence" title="Lifecycle log from real runs" />
      <section className="panel tablePanel">
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Slot</th>
                <th>Commitment</th>
                <th>Event</th>
                <th>Tip</th>
                <th>Classification</th>
                <th>Observation</th>
              </tr>
            </thead>
            <tbody>
              {lifecycleRows.map((row, rowIndex) => (
                <tr key={`${row[0]}-${row[1]}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <SectionTitle kicker="AI Behavior" title="What the agent demonstrated" />
      <section className="grid three">
        <Panel title="Failure Reasoning">
          <p>
            The agent learned from Jito statuses, but raw <code>Invalid</code> was not enough.
            The backend now enriches failures with signature status, blockhash validity,
            sender balance, tip market, and leader window before the diagnostic prompt.
          </p>
        </Panel>
        <Panel title="Tip Selection">
          <p>
            The agent did not use a fixed priority fee. It used live p50/p90 tip
            levels: median when conditions were acceptable, p90 when retrying after
            repeated invalid bundle states.
          </p>
        </Panel>
        <Panel title="Submission Timing">
          <p>
            The agent held a transaction for 5 slots when pulse score and slot health
            were degraded, then submitted after rotation. That shows timing awareness,
            not just retry-on-error behavior.
          </p>
        </Panel>
      </section>

      <SectionTitle kicker="Failure Strategy" title="Captured and classified states" />
      <section className="strategy">
        <div className="decisionTree">
          <div className="branch root">Bundle status</div>
          <div className="branch">Pending → keep polling</div>
          <div className="branch">Landed → watch signature</div>
          <div className="branch good">Confirmed / Finalized → success</div>
          <div className="branch warn">Invalid → collect chain context</div>
          <div className="branch bad">Failed / On-chain err → classify failure</div>
          <div className="branch">Diagnostic AI → RETRY only with payload</div>
        </div>
        <Panel title="Why this matters">
          <p>
            Solana failure modes are not all equal. A skipped leader is a network
            observation. An expired blockhash is a rebuild problem. A Jito `Invalid`
            status is a tracking/execution ambiguity. A signature error is an
            on-chain execution failure. Treating all of these as the same retry is
            how bots waste tips and hide bugs.
          </p>
        </Panel>
      </section>

      <SectionTitle kicker="CTO Questions" title="Answers from the running system" />
      <section className="grid three qa">
        <Panel title="1. processed_at vs confirmed_at delta">
          <p>
            The delta shows how long the cluster took to move from execution in a
            produced block to stronger vote confirmation. In the successful run,
            processed happened at 2,647ms and confirmed at 4,876ms from submission,
            so the processed-to-confirmed gap was about 2.2 seconds. A small gap
            suggests votes propagated normally; a widening gap suggests slower
            confirmation, fork uncertainty, skipped leaders, or validator/vote lag.
          </p>
        </Panel>
        <Panel title="2. Why not finalized blockhash?">
          <p>
            A time-sensitive transaction needs a fresh recent blockhash. Fetching at
            finalized waits for maximum commitment and gives you an older blockhash,
            burning useful validity window before you even sign and submit. Use
            processed or confirmed for current blockhashes, then track confirmation
            separately after submission.
          </p>
        </Panel>
        <Panel title="3. If the Jito leader skips?">
          <p>
            If the leader responsible for the target slot skips, the bundle cannot
            land in that skipped block. It may remain pending briefly, become invalid
            or disappear from Jito tracking, or require resubmission with a fresh
            blockhash and updated tip. CHRONOS records the skip as leader reliability
            data; it only retries if an actual submitted bundle failed and payload
            exists.
          </p>
        </Panel>
      </section>

      <SectionTitle kicker="Screenshots" title="Evidence gallery from the build process" />
      <section className="gallery">
        {gallery.map((img) => (
          <a className="shot" href={`/images/${encodeURIComponent(img)}`} key={img}>
            <img src={`/images/${encodeURIComponent(img)}`} alt={img.replace('.png', '')} />
            <span>{img.replace('.png', '')}</span>
          </a>
        ))}
      </section>

      <section className="footerNote">
        <h2>Deployment note</h2>
        <p>
          This documentation frontend is a normal Next.js app and can be deployed to
          Vercel with <b>Root Directory: document</b>. The CHRONOS backend itself is a
          long-running Node.js service and should be deployed separately on a persistent
          host such as Railway, Fly.io, Render background service, Docker, or a VPS.
        </p>
      </section>
    </main>
  );
}

function SectionTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="sectionTitle">
      <p>{kicker}</p>
      <h2>{title}</h2>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="panel">
      <h3>{title}</h3>
      <div>{children}</div>
    </article>
  );
}
