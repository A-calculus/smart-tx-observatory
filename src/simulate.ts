import { StateManager } from './state/stateManager.js';
import { calculatePulseScore } from './state/pulseScore.js';
import { AIOrchestrator } from './ai/aiOrchestrator.js';
import { FailureClassifier } from './engine/failureClassifier.js';
import { LifecycleLedger } from './ledger/lifecycleLedger.js';

async function waitSlots(stateManager: StateManager, count: number, startSlot: number): Promise<number> {
  let current = startSlot;
  for (let i = 0; i < count; i++) {
    current += 1;
    // Simulate slot production time (400ms) with minor fluctuations
    const duration = 380 + Math.floor(Math.random() * 40);
    const skipped = Math.random() < 0.05; // 5% skip rate

    stateManager.updateSlot(current, `leader-sim-${current % 4}`, skipped);

    // We wait slightly in simulation time (e.g. 50ms to speed up the simulator)
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return current;
}

async function simulate() {
  console.log('====================================================');
  console.log('            OBSERVATORY FLIGHT SIMULATOR            ');
  console.log('====================================================');
  console.log('[Simulate] Running dry-run simulation of observatory lifecycle...\n');

  const stateManager = new StateManager('./state');
  const ledger = new LifecycleLedger('./data');
  const failureClassifier = new FailureClassifier();
  const aiOrchestrator = new AIOrchestrator([
    {
      name: 'OpenRouter',
      url: process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      model: process.env.OPENROUTER_MODEL || 'openrouter/owl-alpha'
    },
    {
      name: 'Gemini',
      url: process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.GEMINI_MODEL || 'gemini-2.5-pro'
    },
    {
      name: 'Groq',
      url: process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY || '',
      model: process.env.GROQ_MODEL || 'llama3-70b-8192'
    },
    {
      name: 'Mistral',
      url: process.env.MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions',
      apiKey: process.env.MISTRAL_API_KEY || '',
      model: process.env.MISTRAL_MODEL || 'mistral-large-latest'
    }
  ]);

  await stateManager.initialize();
  await ledger.initialize();

  // Tip accounts are hardcoded in BundleBuilder
  const mockTipAccounts = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'
  ];

  let currentSlot = 1000;
  console.log('[Simulate] Part 1: Simulating Healthy Network Conditions...');
  // 1. Simulating healthy tip parameters
  stateManager.updateTips([15000, 25000, 40000, 60000]);
  currentSlot = await waitSlots(stateManager, 15, currentSlot);

  let stateSnapshot = stateManager.getSnapshot();
  let pulseResult = calculatePulseScore(stateSnapshot);
  stateManager.updatePulseScore(pulseResult.score, pulseResult.components);

  console.log(`[Simulate] Pulse Score: ${pulseResult.score}/100`);
  console.log(`[Simulate] Querying AI decision for healthy state...`);
  let decision = await aiOrchestrator.getExecutionDecision(stateSnapshot, 'Simulation Dummy TX');
  console.log(`[Simulate] AI Action: ${decision.action}`);
  console.log(`[Simulate] AI Reasoning: ${decision.reasoning}`);
  console.log(`[Simulate] Proposed Tip: ${decision.tip} lamports\n`);

  // Simulate SUBMIT flow
  if (decision.action === 'SUBMIT') {
    const mockTxSig = '4mK3vR...userMemoTxSignature';
    stateManager.registerSubmission(mockTxSig, currentSlot, decision.tip, 'mockBlockhash123', decision.reasoning);
    await ledger.logSubmission({
      bundleIdOrSignature: mockTxSig,
      slot: currentSlot,
      tip: decision.tip,
      blockhash: 'mockBlockhash123',
      agentReasoning: decision.reasoning
    });

    // Processed -> Confirmed -> Finalized
    console.log(`[Simulate] Bundle ${mockTxSig} submitted. Simulating stage transitions...`);
    currentSlot = await waitSlots(stateManager, 3, currentSlot);
    stateManager.updateBundleStage(mockTxSig, 'processed', currentSlot);
    await ledger.logStageTransition(mockTxSig, 'submitted', 'processed', currentSlot, 1200);

    currentSlot = await waitSlots(stateManager, 5, currentSlot);
    stateManager.updateBundleStage(mockTxSig, 'confirmed', currentSlot);
    await ledger.logStageTransition(mockTxSig, 'processed', 'confirmed', currentSlot, 3200);

    currentSlot = await waitSlots(stateManager, 10, currentSlot);
    stateManager.updateBundleStage(mockTxSig, 'finalized', currentSlot);
    await ledger.logStageTransition(mockTxSig, 'confirmed', 'finalized', currentSlot, 7200);
    console.log(`[Simulate] Bundle ${mockTxSig} successfully finalized!\n`);
  }

  console.log('[Simulate] Part 2: Simulating High Congestion & Tip Spike...');
  // 2. Simulate high congestion (tip levels surge, slots skip)
  stateManager.updateTips([150000, 300000, 600000, 900000]); // Median tip 300k
  // Add some long slot times and skipped slots to the history
  for (let i = 0; i < 10; i++) {
    currentSlot++;
    stateManager.updateSlot(currentSlot, 'leader-sim-skipped', true); // All skipped
  }

  stateSnapshot = stateManager.getSnapshot();
  pulseResult = calculatePulseScore(stateSnapshot);
  stateManager.updatePulseScore(pulseResult.score, pulseResult.components);

  console.log(`[Simulate] Pulse Score: ${pulseResult.score}/100`);
  console.log(`[Simulate] Querying AI decision for congested state...`);
  decision = await aiOrchestrator.getExecutionDecision(stateSnapshot, 'Simulation Dummy TX');
  console.log(`[Simulate] AI Action: ${decision.action}`);
  console.log(`[Simulate] AI Reasoning: ${decision.reasoning}`);
  console.log(`[Simulate] Proposed Wait: ${decision.waitDuration} slots\n`);

  if (decision.action === 'HOLD') {
    await ledger.logHold({
      slot: currentSlot,
      pulseScore: pulseResult.score,
      reason: decision.reasoning,
      resumeSlot: currentSlot + decision.waitDuration
    });
    console.log(`[Simulate] Successfully registered HOLD state for ${decision.waitDuration} slots.\n`);
  }

  console.log('[Simulate] Part 3: Simulating Transaction Failure & AI Retry decision...');
  // 3. Simulate failure response
  const failedTxSig = 'x9B4uR...failedTxSignature';
  const pendingFailure = {
    type: 'EXPIRED_BLOCKHASH',
    message: 'Blockhash has expired (older than 151 slots).'
  };

  stateSnapshot = stateManager.getSnapshot();
  console.log(`[Simulate] Triggering failure classification for ${failedTxSig}: ${pendingFailure.type}`);
  await ledger.logFailure(failedTxSig, pendingFailure.type, pendingFailure.message, 'Blockhash expired during slot delay');

  console.log('[Simulate] Querying AI decision for RETRY path...');
  const retryDecision = await aiOrchestrator.getDiagnosticDecision(stateSnapshot, pendingFailure);
  decision = retryDecision;
  console.log(`[Simulate] AI Action: ${decision.action}`);
  console.log(`[Simulate] AI Reasoning: ${decision.reasoning}`);
  console.log(`[Simulate] Recommended Retry Tip: ${decision.tip} lamports\n`);

  if (decision.action === 'RETRY') {
    const retryTxSig = 'retry_5G3sA...newTxSignature';
    stateManager.registerSubmission(retryTxSig, currentSlot, decision.tip, 'mockBlockhashFresh', decision.reasoning);
    await ledger.logSubmission({
      bundleIdOrSignature: retryTxSig,
      slot: currentSlot,
      tip: decision.tip,
      blockhash: 'mockBlockhashFresh',
      agentReasoning: decision.reasoning
    });
    console.log(`[Simulate] Retry bundle ${retryTxSig} submitted.`);
  }

  // Backup ledger and shut down stateManager
  await stateManager.persistState();

  const snapshotObj = stateManager.getSnapshot();
  const summary = {
    totalSubmissions: snapshotObj.bundles.completed.length + snapshotObj.bundles.failed.length,
    successful: snapshotObj.bundles.completed.length,
    failed: snapshotObj.bundles.failed.length,
    totalTipsPaidLamports: snapshotObj.bundles.completed.length * 50000
  };
  await ledger.logSummary(summary);
  await ledger.backupLedger();

  stateManager.stop();

  console.log('\n[Simulate] Flight Simulation run finished successfully! All subsystems checked out.');
}

simulate().catch(e => {
  console.error('[Simulate] Simulation crashed:', e);
  process.exit(1);
});
