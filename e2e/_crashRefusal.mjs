/** Synthetic negative-control evidence; never infers a lock from exit alone. */
export function observedSyntheticLockRefusal(e) {
  return e.firstAlive===true && e.exit?.code===0 && e.exit?.signal===null &&
    e.refusalMarker===true && e.windowMs===null && e.profileExists===false && e.diagExists===false;
}
