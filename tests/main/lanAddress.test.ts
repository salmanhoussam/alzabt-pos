/**
 * Choosing the LAN address a phone can reach — against adapter lists this machine cannot produce.
 *
 * 🔴 EVERY FIXTURE HERE IS A REAL SHAPE, NOT AN INVENTED ONE. A Windows shop PC has "Ethernet",
 * "Wi-Fi", "vEthernet (Default Switch)" from Hyper-V, "Loopback Pseudo-Interface 1" and, on a
 * laptop that once joined a VPN, a tunnel adapter. This Linux test box has `lo` and one `wlan0`,
 * so the selection logic could otherwise only ever be exercised against the easiest possible case
 * — which is exactly the case that never goes wrong in a shop.
 */
import { describe, expect, it } from "vitest";
import { selectLanAddress, type NetworkInterfaceMap } from "../../src/main/lanAddress";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });
const v6 = (address: string, internal = false) => ({ address, family: "IPv6", internal });

describe("a plain shop PC", () => {
  it("one Ethernet adapter is chosen without a question", () => {
    const map: NetworkInterfaceMap = {
      "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true), v6("::1", true)],
      Ethernet: [v4("192.168.1.20"), v6("fe80::1")],
    };
    const r = selectLanAddress(map);
    expect(r.kind).toBe("single");
    expect(r.kind !== "none" && r.chosen.address).toBe("192.168.1.20");
    expect(r.kind !== "none" && r.chosen.interfaceName).toBe("Ethernet");
  });

  /**
   * 🔴 LOOPBACK IS NEVER A CANDIDATE, AND "none" IS THE HONEST ANSWER. A machine with only
   * loopback is not on a network; returning 127.0.0.1 would produce a QR the phone resolves to
   * itself, which fails with no error to explain it.
   */
  it("🔴 a machine with ONLY loopback yields none — never 127.0.0.1", () => {
    const map: NetworkInterfaceMap = {
      "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true), v6("::1", true)],
    };
    const r = selectLanAddress(map);
    expect(r.kind).toBe("none");
    expect(r.kind === "none" && r.reason).toMatch(/network/i);
  });

  it("an empty adapter list yields none", () => {
    expect(selectLanAddress({}).kind).toBe("none");
  });

  it("IPv6-only is not usable for this QR", () => {
    const map: NetworkInterfaceMap = { Ethernet: [v6("2001:db8::1"), v6("fe80::1")] };
    expect(selectLanAddress(map).kind).toBe("none");
  });

  it("accepts the numeric family 4, not only the string 'IPv4'", () => {
    // Node reports "IPv4"; older and alternative shapes reported the number. Depending on which
    // one this runtime happens to use would make the picker silently find nothing elsewhere.
    const map: NetworkInterfaceMap = { eth0: [{ address: "10.0.0.5", family: 4, internal: false }] };
    const r = selectLanAddress(map);
    expect(r.kind).toBe("single");
    expect(r.kind !== "none" && r.chosen.address).toBe("10.0.0.5");
  });
});

describe("virtual adapters are DEPRIORITISED, not banned", () => {
  /**
   * 🔴 THIS IS THE CASE THAT BREAKS SHOPS. Hyper-V, Docker Desktop and WSL all add adapters with
   * private addresses that look exactly as legitimate as the real one to a naive picker. The real
   * adapter must win — and it must win DECISIVELY, without asking the merchant anything.
   */
  it("🔴 a real Wi-Fi adapter beats Hyper-V, Docker and WSL, with no question asked", () => {
    const map: NetworkInterfaceMap = {
      "vEthernet (Default Switch)": [v4("172.20.96.1")],
      "vEthernet (WSL)": [v4("172.30.80.1")],
      "Docker Desktop": [v4("10.99.0.1")],
      "Wi-Fi": [v4("192.168.1.42")],
      "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)],
    };
    const r = selectLanAddress(map);
    expect(r.kind).toBe("single");
    expect(r.kind !== "none" && r.chosen.address).toBe("192.168.1.42");
  });

  /**
   * 🔴 AND THE NOT-BANNED HALF, WHICH IS WHY THE RULE IS A RANKING. The deprioritised-name list is
   * a heuristic over localised, third-party-chosen adapter names — it cannot be complete. If a name
   * match REMOVED an adapter, a shop whose only network happened to match would get no address at
   * all. Here the virtual-looking adapter is the only one, and it is still offered.
   */
  it("🔴 a virtual-looking adapter is still USED when it is the only one", () => {
    const map: NetworkInterfaceMap = {
      "vEthernet (Default Switch)": [v4("192.168.137.1")],
      "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)],
    };
    const r = selectLanAddress(map);
    expect(r.kind).toBe("single");
    expect(r.kind !== "none" && r.chosen.address).toBe("192.168.137.1");
  });

  it("a VPN tunnel loses to the real adapter", () => {
    const map: NetworkInterfaceMap = {
      Tailscale: [v4("100.101.102.103")],
      WireGuard: [v4("10.8.0.2")],
      Ethernet: [v4("192.168.0.10")],
    };
    const r = selectLanAddress(map);
    expect(r.kind !== "none" && r.chosen.address).toBe("192.168.0.10");
  });
});

describe("APIPA", () => {
  /**
   * 169.254.x.x means DHCP did not answer. It is technically routable on the link and almost never
   * what the shop's phone is on — so it sorts last, below even an unrecognised range.
   */
  it("🔴 loses to every real address, and says why when it is all there is", () => {
    const withReal: NetworkInterfaceMap = {
      Ethernet: [v4("169.254.10.20")],
      "Wi-Fi": [v4("192.168.1.5")],
    };
    expect(selectLanAddress(withReal).kind !== "none" && (selectLanAddress(withReal) as { chosen: { address: string } }).chosen.address)
      .toBe("192.168.1.5");

    const only: NetworkInterfaceMap = { Ethernet: [v4("169.254.10.20")] };
    const r = selectLanAddress(only);
    // Offered rather than hidden — but the note tells a support call what it is looking at.
    expect(r.kind).toBe("single");
    expect(r.kind !== "none" && r.chosen.note).toMatch(/DHCP/i);
  });
});

describe("genuine ambiguity", () => {
  /**
   * 🔴 THE ONE CASE THAT MUST ASK. A laptop on Wi-Fi AND Ethernet has two equally real addresses,
   * and the phone can only reach one of them. Silently picking means a merchant whose phone cannot
   * connect is told nothing is wrong — the exact failure the approved design forbids.
   */
  it("🔴 two real LAN adapters report ambiguous and carry BOTH candidates", () => {
    const map: NetworkInterfaceMap = {
      Ethernet: [v4("192.168.1.20")],
      "Wi-Fi": [v4("10.0.0.50")],
      "vEthernet (WSL)": [v4("172.30.80.1")],
    };
    const r = selectLanAddress(map);
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    // A best guess is still offered, so the desktop has something to show immediately.
    expect(r.chosen.address).toBe("192.168.1.20");
    // And every candidate is reported, so a retry path exists without re-measuring the machine.
    const addresses = r.candidates.map((c) => c.address);
    expect(addresses).toContain("192.168.1.20");
    expect(addresses).toContain("10.0.0.50");
    expect(addresses).toContain("172.30.80.1");
    for (const c of r.candidates) expect(c.note).not.toBe("");
  });

  /**
   * 🔴 THE CONTROL THAT KEEPS "AMBIGUOUS" MEANINGFUL. More than one ADDRESS is not more than one
   * CHOICE. If every extra adapter made the result ambiguous, a normal Windows PC with Hyper-V
   * installed would ask the merchant a question it already knows the answer to — and a prompt that
   * fires every time is a prompt nobody reads.
   */
  it("🔴 one real adapter plus virtual ones is NOT ambiguous", () => {
    const map: NetworkInterfaceMap = {
      "vEthernet (Default Switch)": [v4("172.20.96.1")],
      "VirtualBox Host-Only Network": [v4("192.168.56.1")],
      Ethernet: [v4("192.168.1.20")],
    };
    expect(selectLanAddress(map).kind).toBe("single");
  });

  it("a 192.168 address outranks a 10.x one, deterministically", () => {
    const a = selectLanAddress({ A: [v4("10.0.0.1")], B: [v4("192.168.1.1")] });
    const b = selectLanAddress({ B: [v4("192.168.1.1")], A: [v4("10.0.0.1")] });
    // 🔴 THE SAME MACHINE MUST GIVE THE SAME ANSWER. `os.networkInterfaces()` does not specify its
    // order, so an unsorted pick would make the chosen address vary between runs — and the QR with
    // it.
    expect(a.kind !== "none" && a.chosen.address).toBe("192.168.1.1");
    expect(b.kind !== "none" && b.chosen.address).toBe("192.168.1.1");
  });

  it("172.16/12 is private but 172.32 is not", () => {
    const inRange = selectLanAddress({ eth0: [v4("172.16.5.5")] });
    expect(inRange.kind !== "none" && inRange.chosen.note).toMatch(/private LAN/i);
    const outOfRange = selectLanAddress({ eth0: [v4("172.32.5.5")] });
    expect(outOfRange.kind !== "none" && outOfRange.chosen.note).toMatch(/unrecognised/i);
  });
});
