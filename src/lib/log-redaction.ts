/**
 * Keeping patient references out of request logs (#55).
 *
 * `beneficiaryRef` is a stable pseudonym for a patient: anyone who can read
 * the logs can link every visit that reference appears in, and logs are kept
 * longer and shared more widely than the database. The reference therefore
 * never gets to appear in a log line, and the request URL is the one place
 * the framework writes it by itself.
 */

/**
 * Match `beneficiaryRef=<value>` only where it is a real query parameter:
 * introduced by `?` or `&`, running to the next `&`, a `#` fragment, or the
 * end of the URL. Case-insensitive so a differently-cased repeat of the same
 * filter cannot slip a reference past the mask.
 */
const BENEFICIARY_REF_PARAM = /([?&]beneficiaryRef=)[^&#]*/gi;

/** A marker with no patient data in it, shaped so readers know it was masked. */
const REDACTED = '%5Bredacted%5D';

/**
 * Replace every `beneficiaryRef` query value with `%5Bredacted%5D`, leaving
 * the parameter name (so log readers still see the filter was used), every
 * other parameter, and the path untouched. An empty value is left as-is:
 * there is nothing to hide, and the route validators reject it anyway.
 */
export function redactBeneficiaryRef(url: string): string {
  return url.replace(BENEFICIARY_REF_PARAM, (match, prefix: string) => {
    const value = match.slice(prefix.length);
    return value === '' ? match : prefix + REDACTED;
  });
}
