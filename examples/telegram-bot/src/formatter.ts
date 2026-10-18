/**
 * Webhook payload from SCI Healthcare indexer.
 * STRICT PRIVACY GUARANTEE:
 * Beneficiary references and patient secrets are never sent by the indexer
 * and never included in clinic messages.
 */
export type WebhookVoucherPayload = {
  event: string;
  voucherId: string;
  status: string;
  txHash?: string | null;
  ledger?: number | null;
  amount?: string | null;
  amountDisplay?: string | null;
  serviceCode?: number | null;
  serviceLabel?: string | null;
  providerAddress?: string | null;
  [key: string]: unknown;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats a Telegram notification message for clinic staff.
 * Throws an Error if any beneficiary reference is present in the payload.
 */
export function formatTelegramMessage(payload: WebhookVoucherPayload): string {
  // Defensive assertion: ensure no beneficiary identifier is ever processed or posted
  if (
    'beneficiaryRef' in payload ||
    'beneficiary' in payload ||
    'patient' in payload ||
    'beneficiary_ref' in payload
  ) {
    throw new Error('Privacy violation: payload contains beneficiary references');
  }

  const event = String(payload.event ?? 'voucher_event');
  const voucherId = String(payload.voucherId ?? 'N/A');
  const status = String(payload.status ?? 'Updated');
  const amount = payload.amountDisplay
    ? `${payload.amountDisplay} USDC`
    : payload.amount
      ? `${payload.amount} stroops`
      : null;
  const service = payload.serviceLabel ?? (payload.serviceCode ? `Service #${payload.serviceCode}` : null);
  const ledger = payload.ledger ? `(Ledger #${payload.ledger})` : '';

  let header = '🔔 <b>Voucher Notification</b>';
  if (status === 'Funded' || event === 'voucher_funded') {
    header = '🏥 <b>New Care Voucher Funded!</b>';
  } else if (status === 'Claimed' || event === 'voucher_claimed') {
    header = '📋 <b>Voucher Claimed</b>';
  } else if (status === 'Attested' || event === 'voucher_attested') {
    header = '🩺 <b>Voucher Attested</b>';
  } else if (status === 'Settled' || event === 'voucher_settled') {
    header = '✅ <b>Voucher Settled & Paid</b>';
  } else if (status === 'Disputed' || event === 'voucher_disputed') {
    header = '⚠️ <b>Voucher Disputed</b>';
  } else if (status === 'Refunded' || event === 'voucher_refunded') {
    header = '↩️ <b>Voucher Refunded</b>';
  }

  const lines = [
    header,
    '',
    `• <b>Voucher ID:</b> <code>${escapeHtml(voucherId)}</code>`,
    `• <b>Status:</b> ${escapeHtml(status)} ${ledger}`.trim(),
  ];

  if (amount) {
    lines.push(`• <b>Amount:</b> ${escapeHtml(amount)}`);
  }
  if (service) {
    lines.push(`• <b>Service:</b> ${escapeHtml(service)}`);
  }
  if (payload.txHash) {
    lines.push(`• <b>Tx:</b> <code>${escapeHtml(String(payload.txHash))}</code>`);
  }

  if (status === 'Funded' || event === 'voucher_funded') {
    lines.push('', '<i>Action: Please examine the patient upon arrival and submit your claim.</i>');
  }

  return lines.join('\n');
}
