export type FailureType = 
  | 'EXPIRED_BLOCKHASH'
  | 'FEE_TOO_LOW'
  | 'COMPUTE_EXCEEDED'
  | 'BUNDLE_FAILURE_ATOMIC'
  | 'LEADER_SKIP'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface FailureRecord {
  bundleIdOrSignature: string;
  failureType: FailureType;
  message: string;
}

export class FailureClassifier {
  /**
   * Classifies errors thrown directly during Jito bundle submission.
   */
  public classifyJitoError(error: any, bundleIdOrSignature: string): FailureRecord {
    const errorMsg = String(error?.message || error || '').toLowerCase();
    
    let failureType: FailureType = 'UNKNOWN';
    let message = 'Jito submission rejected for unknown reason.';

    if (errorMsg.includes('blockhash') || errorMsg.includes('slot expired') || errorMsg.includes('stale')) {
      failureType = 'EXPIRED_BLOCKHASH';
      message = 'The transaction blockhash was older than 151 slots or rejected as stale.';
    } else if (errorMsg.includes('bid') || errorMsg.includes('tip') || errorMsg.includes('fee') || errorMsg.includes('below minimum')) {
      failureType = 'FEE_TOO_LOW';
      message = 'The bundle tip was below the minimum required for validator auction inclusion.';
    } else if (errorMsg.includes('revert') || errorMsg.includes('atomic') || errorMsg.includes('failed to compile')) {
      failureType = 'BUNDLE_FAILURE_ATOMIC';
      message = 'One of the transactions in the bundle failed to parse or was invalid.';
    } else {
      message = `Jito submission failed: ${error?.message || error}`;
    }

    return {
      bundleIdOrSignature,
      failureType,
      message
    };
  }

  /**
   * Classifies on-chain execution errors returned in Transaction status.
   */
  public classifyOnChainError(err: any, bundleIdOrSignature: string): FailureRecord {
    let failureType: FailureType = 'BUNDLE_FAILURE_ATOMIC';
    let message = 'Transaction execution reverted on-chain.';

    const errStr = JSON.stringify(err).toLowerCase();

    if (errStr.includes('computebudgetexceeded') || errStr.includes('compute limit') || errStr.includes('exceeded limit')) {
      failureType = 'COMPUTE_EXCEEDED';
      message = 'Transaction used more compute units than the budget allocated.';
    } else if (errStr.includes('blockhashnotfound') || errStr.includes('blockhash expired')) {
      failureType = 'EXPIRED_BLOCKHASH';
      message = 'Transaction reached validator after blockhash expired.';
    } else if (errStr.includes('instructionerror')) {
      message = `Transaction reverted during instruction execution: ${JSON.stringify(err)}`;
    } else {
      message = `On-chain execution failed: ${JSON.stringify(err)}`;
    }

    return {
      bundleIdOrSignature,
      failureType,
      message
    };
  }

  /**
   * Utility to classify leader skips based on slot sequence differences.
   */
  public classifyLeaderSkip(bundleIdOrSignature: string, targetSlot: number, actualSlot: number): FailureRecord {
    return {
      bundleIdOrSignature,
      failureType: 'LEADER_SKIP',
      message: `The validator scheduled for targeted slot ${targetSlot} failed to produce a block. Actual block landed in slot ${actualSlot}.`
    };
  }
}
