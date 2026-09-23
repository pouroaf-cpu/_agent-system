// Owner is an explicit human dependency, not a synonym for failed verification.
export function explicitOwnerReason(text) {
  return /\bonly (?:the )?(?:operator|owner|user|human)\b/i.test(text)
    && /\b(?:access|permission|credential|2fa|mfa)\b/i.test(text)
    && /\bverified\b/i.test(text) && /\bevidence\s*:/i.test(text)
    && /approved[^.\n]{0,100}(?:exhausted|unavailable|insufficient)/i.test(text)
    && !/\bnot true that[^.\n]{0,80}\s+only (?:the )?(?:operator|owner|user|human)|not only (?:the )?(?:operator|owner|user|human)/i.test(text)
}
