/**
 * Lobby session — the piece that was missing between a working game and a
 * working radio.
 *
 * Owns the transport for the pre-match phase: advertising or scanning, seating
 * players, and agreeing on teams. Hands off to MatchHost/MatchClient when the
 * host starts.
 *
 * Deliberately free of React so the state machine is testable without a
 * renderer. The screen subscribes via `onChange`.
 *
 * ## The host is authoritative and clients only request
 *
 * A client tapping "team 2" sends `SetTeam` and changes nothing locally — it
 * waits for the roster to come back. Two people tapping the same team at the
 * same moment is ordinary, and an optimistic local change leaves two phones
 * disagreeing about who is on which side right up until the match starts, which
 * is the worst possible moment to find out.
 *
 * ## Slots are identified by slotId, never by array position
 *
 * A player leaving shifts every later index. `slotId` is assigned by the host
 * and survives departures, which is why `Welcome` exists at all: a broadcast
 * roster cannot tell each client which row is itself.
 */

import {
  LobbyOp,
  MsgType,
  Reader,
  Writer,
  clampName,
  readRoster,
  writeLobbyJoin,
  writeLobbySetReady,
  writeLobbySetTeam,
  writeLobbyWelcome,
  writeRoster,
  type Peer,
  type PeerId,
  type Transport,
  type WireLobbySlot,
  type WireRoster,
} from '@tanks/core';

export type LobbyRole = 'idle' | 'hosting' | 'browsing' | 'joined';

export interface DiscoveredHost {
  id: PeerId;
  name: string;
}

/** Free-for-all vs teams is a label for the UI; the sim only reads `team`. */
export const MODE_FFA = 0;
export const MODE_TEAMS = 1;

export const MAX_SLOTS = 8;

export interface LobbyState {
  role: LobbyRole;
  /** Populated while browsing. */
  hosts: DiscoveredHost[];
  roster: WireRoster;
  /** Which slot this device is. -1 until Welcome arrives (or, hosting, 0). */
  mySlotId: number;
  error: string | null;
}

function emptyRoster(): WireRoster {
  return { mapId: 0, mode: MODE_FFA, roundsToWin: 3, slots: [] };
}

export class LobbySession {
  private state: LobbyState = {
    role: 'idle',
    hosts: [],
    roster: emptyRoster(),
    mySlotId: -1,
    error: null,
  };

  /** Host only: which peer occupies which slot. */
  private peerBySlot = new Map<number, PeerId>();
  private nextSlotId = 0;

  onChange: (() => void) | null = null;

  constructor(
    private transport: Transport,
    private localName: string,
  ) {}

  get(): Readonly<LobbyState> {
    return this.state;
  }

  private emit(): void {
    this.onChange?.();
  }

  private fail(where: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.state.error = `${where}: ${message}`;
    this.emit();
  }

  // ---- hosting ------------------------------------------------------------

  async startHosting(matchName = 'Tanks!'): Promise<void> {
    try {
      this.installEvents();
      await this.transport.host(matchName);
      this.state.role = 'hosting';
      this.state.roster = emptyRoster();
      // The host takes slot 0 and is always seated: it plays, it is not a
      // dedicated server.
      this.nextSlotId = 0;
      const me = this.seat(clampName(this.localName), true);
      this.state.mySlotId = me.slotId;
      this.emit();
    } catch (err) {
      this.fail('host', err);
    }
  }

  private seat(name: string, isHost: boolean): WireLobbySlot {
    const slot: WireLobbySlot = {
      slotId: this.nextSlotId++,
      name,
      // Default every player onto their own team. That is free-for-all, and it
      // is also the only default that never silently puts two strangers on the
      // same side.
      team: this.state.roster.slots.length,
      ready: isHost,
      isHost,
    };
    this.state.roster.slots.push(slot);
    return slot;
  }

  private broadcastRoster(): void {
    const w = new Writer();
    writeRoster(w, this.state.roster);
    this.transport.broadcast(w.finish(), true);
  }

  private welcome(peerId: PeerId, slotId: number): void {
    const w = new Writer();
    writeLobbyWelcome(w, slotId);
    this.transport.send(peerId, w.finish(), true);
  }

  // ---- joining ------------------------------------------------------------

  async startBrowsing(): Promise<void> {
    try {
      this.installEvents();
      this.state.role = 'browsing';
      this.state.hosts = [];
      this.emit();
      await this.transport.discover();
    } catch (err) {
      this.fail('discover', err);
    }
  }

  async join(peerId: PeerId): Promise<void> {
    try {
      await this.transport.join(peerId);
      const w = new Writer();
      writeLobbyJoin(w, clampName(this.localName));
      this.transport.send(peerId, w.finish(), true);
      this.state.role = 'joined';
      this.emit();
    } catch (err) {
      this.fail('join', err);
    }
  }

  // ---- player actions -----------------------------------------------------

  /**
   * Request a team change. Does not touch local state — see the note at the top
   * about why optimistic updates are wrong here.
   */
  setTeam(team: number): void {
    if (this.state.role === 'hosting') {
      const slot = this.slotById(this.state.mySlotId);
      if (slot) {
        slot.team = team;
        this.broadcastRoster();
        this.emit();
      }
      return;
    }
    const w = new Writer();
    writeLobbySetTeam(w, team);
    this.transport.broadcast(w.finish(), true);
  }

  setReady(ready: boolean): void {
    if (this.state.role === 'hosting') {
      const slot = this.slotById(this.state.mySlotId);
      if (slot) {
        slot.ready = ready;
        this.broadcastRoster();
        this.emit();
      }
      return;
    }
    const w = new Writer();
    writeLobbySetReady(w, ready);
    this.transport.broadcast(w.finish(), true);
  }

  /** Host only. */
  setMode(mode: number): void {
    if (this.state.role !== 'hosting') return;
    this.state.roster.mode = mode;
    if (mode === MODE_TEAMS) {
      // Alternate sides so "teams" means something the moment it is selected,
      // rather than leaving eight one-player teams labelled as teams.
      this.state.roster.slots.forEach((s, i) => {
        s.team = i % 2;
      });
    } else {
      this.state.roster.slots.forEach((s, i) => {
        s.team = i;
      });
    }
    this.broadcastRoster();
    this.emit();
  }

  /** Host only. */
  setMap(mapId: number): void {
    if (this.state.role !== 'hosting') return;
    this.state.roster.mapId = mapId;
    this.broadcastRoster();
    this.emit();
  }

  canStart(): boolean {
    const s = this.state;
    return (
      s.role === 'hosting' &&
      s.roster.slots.length >= 2 &&
      s.roster.slots.every((x) => x.ready)
    );
  }

  /** Host only: peer id for a seated slot, for wiring MatchHost.addClient. */
  peerForSlot(slotId: number): PeerId | undefined {
    return this.peerBySlot.get(slotId);
  }

  slotById(slotId: number): WireLobbySlot | undefined {
    return this.state.roster.slots.find((s) => s.slotId === slotId);
  }

  // ---- transport plumbing -------------------------------------------------

  /**
   * `setEvents` merges as of core `78f1586`, so this adds handlers without
   * clobbering any that MatchHost/MatchClient install later. Before that fix it
   * replaced wholesale, and this exact call would have silently killed the
   * match's onPacket — see issue #6.
   */
  private installEvents(): void {
    this.transport.setEvents({
      onPeerJoin: (peer: Peer) => this.handlePeerJoin(peer),
      onPeerLeave: (peerId: PeerId) => this.handlePeerLeave(peerId),
      onPacket: (from: PeerId, data: Uint8Array) =>
        this.handleLobbyPacket(from, data),
      onError: (err: Error) => this.fail('transport', err),
    });
  }

  private handlePeerJoin(peer: Peer): void {
    if (this.state.role === 'browsing') {
      if (!this.state.hosts.some((h) => h.id === peer.id)) {
        this.state.hosts.push({ id: peer.id, name: peer.name });
        this.emit();
      }
      return;
    }
    // Hosting: a peer connecting is not yet a seated player. Seating waits for
    // their Join, which carries the name.
  }

  private handlePeerLeave(peerId: PeerId): void {
    if (this.state.role === 'browsing') {
      this.state.hosts = this.state.hosts.filter((h) => h.id !== peerId);
      this.emit();
      return;
    }
    for (const [slotId, id] of this.peerBySlot) {
      if (id === peerId) {
        this.peerBySlot.delete(slotId);
        this.state.roster.slots = this.state.roster.slots.filter(
          (s) => s.slotId !== slotId,
        );
        this.broadcastRoster();
        this.emit();
        return;
      }
    }
  }

  /**
   * Only consumes Lobby messages and ignores everything else, so that once a
   * match starts this can stay installed alongside MatchHost/MatchClient
   * without stealing their packets.
   */
  private handleLobbyPacket(from: PeerId, data: Uint8Array): void {
    if (data.length < 2 || data[0] !== MsgType.Lobby) return;
    const r = new Reader(data);
    r.u8(); // MsgType
    const op = r.u8();

    try {
      if (this.state.role === 'hosting') {
        this.handleHostSide(from, op, r);
      } else {
        this.handleClientSide(op, r);
      }
    } catch (err) {
      // A truncated or malformed lobby packet must not take the screen down.
      // Reader throws TruncatedPacketError on short reads as of core 69528c6.
      this.fail('lobby packet', err);
    }
  }

  private handleHostSide(from: PeerId, op: number, r: Reader): void {
    if (op === LobbyOp.Join) {
      if (this.state.roster.slots.length >= MAX_SLOTS) return;
      const name = r.str();
      const slot = this.seat(clampName(name) || 'Player', false);
      this.peerBySlot.set(slot.slotId, from);
      this.welcome(from, slot.slotId);
      this.broadcastRoster();
      this.emit();
      return;
    }

    const slotId = this.slotIdForPeer(from);
    if (slotId === undefined) return;
    const slot = this.slotById(slotId);
    if (!slot) return;

    if (op === LobbyOp.SetTeam) {
      slot.team = r.u8();
    } else if (op === LobbyOp.SetReady) {
      slot.ready = r.u8() !== 0;
    } else {
      return;
    }
    this.broadcastRoster();
    this.emit();
  }

  private handleClientSide(op: number, r: Reader): void {
    if (op === LobbyOp.Roster) {
      // readRoster expects to start after the two header bytes, which the
      // caller has already consumed.
      this.state.roster = readRoster(r);
      this.emit();
    } else if (op === LobbyOp.Welcome) {
      this.state.mySlotId = r.u8();
      this.emit();
    }
  }

  private slotIdForPeer(peerId: PeerId): number | undefined {
    for (const [slotId, id] of this.peerBySlot) {
      if (id === peerId) return slotId;
    }
    return undefined;
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } catch {
      // Closing a transport that never opened is not worth surfacing.
    }
    this.state = {
      role: 'idle',
      hosts: [],
      roster: emptyRoster(),
      mySlotId: -1,
      error: null,
    };
    this.peerBySlot.clear();
    this.emit();
  }
}
