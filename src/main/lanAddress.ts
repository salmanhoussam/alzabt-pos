/**
 * Choosing the one LAN IPv4 address a phone can actually reach.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE FUNCTION IS PURE AND TAKES THE INTERFACE MAP AS AN ARGUMENT, rather than calling
 * `os.networkInterfaces()` itself. A shop PC's adapter list is exactly the thing this code must
 * handle correctly and exactly the thing a test machine cannot reproduce: this Linux box has no
 * Windows "Ethernet 2", no Hyper-V vEthernet, no Npcap loopback and no VPN tunnel. Taking the map
 * as data means every one of those cases is a test fixture instead of an unknown.
 *
 * 🔴 IT NEVER SILENTLY GUESSES. When more than one plausible adapter exists the result says so and
 * carries ALL of them, because the approved design requires enough information for a future UI to
 * offer a choice. A single address returned from an ambiguous machine is the failure mode where a
 * shop's phone cannot connect and the till insists everything is fine.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The shape `os.networkInterfaces()` returns, narrowed to what this decision needs. */
export interface NetworkAddress {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
  readonly mac?: string;
}

export type NetworkInterfaceMap = Readonly<Record<string, readonly NetworkAddress[] | undefined>>;

/** One adapter that could carry the phone, with the reasoning that ranked it. */
export interface LanCandidate {
  readonly interfaceName: string;
  readonly address: string;
  /** Lower sorts first. Private LAN ranges beat everything; link-local is last. */
  readonly rank: number;
  /** Why this one scored as it did — surfaced so a support call has something to read. */
  readonly note: string;
}

export type LanSelection =
  /** Exactly one plausible address. Use it. */
  | { readonly kind: "single"; readonly chosen: LanCandidate }
  /**
   * Several plausible addresses. `chosen` is the best GUESS and is safe to offer, but the caller
   * must report `candidates` so the operator can switch if the phone cannot connect.
   */
  | { readonly kind: "ambiguous"; readonly chosen: LanCandidate; readonly candidates: readonly LanCandidate[] }
  /** Nothing a phone could reach. There is no address to fall back to — loopback is not one. */
  | { readonly kind: "none"; readonly reason: string };

/**
 * Adapter names that are virtual far more often than they are a shop's real network.
 *
 * 🔴 THIS IS A DEPRIORITISATION, NOT A BAN. A name match pushes an adapter below the real ones; it
 * never removes it. Two reasons, both measured rather than assumed: a shop could genuinely run its
 * network over an adapter whose name matches one of these, and the list is heuristic — it cannot
 * be complete, because adapter names are localised on Windows and chosen by whatever software
 * installed them. Banning on a guess would leave a working shop with no address at all.
 */
const DEPRIORITISED_NAME = /\b(v?ethernet \(|vmware|virtualbox|vbox|hyper-?v|docker|wsl|tailscale|zerotier|wireguard|openvpn|tap-|tun\d|npcap|loopback|bluetooth|teredo|isatap)/i;

/** 169.254.0.0/16 — an address Windows assigns when DHCP failed. Reachable in theory, broken in practice. */
function isApipa(address: string): boolean {
  return /^169\.254\./.test(address);
}

/** The RFC1918 ranges plus CGNAT — what a real shop LAN looks like. */
function privateRank(address: string): number | null {
  if (/^192\.168\./.test(address)) return 0; // the overwhelmingly common home/shop router
  if (/^10\./.test(address)) return 1; // common in offices and some ISP routers
  const m = /^172\.(\d{1,3})\./.exec(address);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return 2; // 172.16/12
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 3; // 100.64/10 CGNAT
  return null;
}

function isIpv4(a: NetworkAddress): boolean {
  // Node ≥18 reports the string "IPv4"; older/other shapes reported the number 4. Accept both
  // rather than depending on which one this runtime happens to use.
  return a.family === "IPv4" || a.family === 4;
}

/**
 * Rank every adapter and decide.
 *
 * The ordering, highest priority first:
 *   1. a private LAN address on a normally-named adapter   (what a shop actually has)
 *   2. a private LAN address on a virtual-looking adapter  (plausible, but probably not it)
 *   3. a public/unclassified address                       (unusual; offered rather than hidden)
 *   4. APIPA 169.254.x.x                                   (DHCP failed; almost never right)
 * Loopback and non-IPv4 are excluded outright — a phone cannot use either.
 */
export function selectLanAddress(interfaces: NetworkInterfaceMap): LanSelection {
  const candidates: LanCandidate[] = [];

  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    for (const a of addresses ?? []) {
      if (!isIpv4(a)) continue;
      // `internal` is Node's own loopback flag. Excluded, and the QR builder refuses loopback
      // again independently — two layers, because putting 127.0.0.1 in a QR is unrecoverable.
      if (a.internal) continue;
      if (/^127\./.test(a.address)) continue;

      const virtualLooking = DEPRIORITISED_NAME.test(interfaceName);
      const priv = privateRank(a.address);

      let rank: number;
      let note: string;
      if (isApipa(a.address)) {
        rank = 300;
        note = "self-assigned address (169.254.x.x) — DHCP did not answer on this adapter";
      } else if (priv !== null && !virtualLooking) {
        rank = 0 + priv;
        note = "private LAN address on a physical-looking adapter";
      } else if (priv !== null) {
        rank = 100 + priv;
        note = "private LAN address, but the adapter name looks virtual";
      } else {
        rank = virtualLooking ? 250 : 200;
        note = virtualLooking
          ? "unrecognised address range on a virtual-looking adapter"
          : "unrecognised address range — not a private LAN range";
      }
      candidates.push({ interfaceName, address: a.address, rank, note });
    }
  }

  if (candidates.length === 0) {
    return {
      kind: "none",
      reason: "This computer has no network address a phone could reach. Connect it to the shop Wi-Fi or network cable.",
    };
  }

  // Deterministic: rank, then address, then interface name. Never insertion order — the order
  // `os.networkInterfaces()` returns is not specified, so an unsorted pick would make the chosen
  // address vary between runs on one machine.
  candidates.sort(
    (x, y) => x.rank - y.rank || x.address.localeCompare(y.address) || x.interfaceName.localeCompare(y.interfaceName),
  );

  const chosen = candidates[0]!;
  if (candidates.length === 1) return { kind: "single", chosen };

  // 🔴 "AMBIGUOUS" MEANS MORE THAN ONE PLAUSIBLE CHOICE, NOT MORE THAN ONE ADDRESS. A machine with
  // one real LAN address and one Hyper-V adapter is NOT a question for the operator: the real one
  // wins decisively. Ambiguity is when two candidates are genuinely comparable — which is exactly
  // the laptop-on-Wi-Fi-and-Ethernet case the study named.
  const rivals = candidates.filter((c) => c.rank < 100);
  if (rivals.length > 1) return { kind: "ambiguous", chosen, candidates };
  return { kind: "single", chosen };
}
