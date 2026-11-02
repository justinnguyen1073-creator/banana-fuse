const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function createVoice({ send }) {
  const peers = new Map();
  let state = null;
  let stream = null;
  let micTrack = null;
  let micState = 'unavailable';
  let context = null;
  let localMeter = null;
  let ready = false;
  let starting = null;
  let generation = 0;

  const playing = () => state?.game?.status === 'playing';
  const ownRole = () => state?.game?.role?.id
    ?? state?.players.find((p) => p.id === state.you)?.role;
  const deafened = () => playing() && ownRole() === 'eyes';
  const mutedByRole = () => playing() && ownRole() === 'reader';
  const audible = (id) => Boolean(state) && !deafened()
    && (!playing() || state.players.find((p) => p.id === id)?.role !== 'reader');
  const live = (peer) => peers.get(peer.id) === peer && !peer.closed;

  function signal(peer, data) {
    if (live(peer)) send({ t: 'rtc', to: peer.id, data });
  }

  function meterFor(media) {
    if (!context) return null;
    try {
      const source = context.createMediaStreamSource(media);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return { source, analyser, samples: new Float32Array(analyser.fftSize) };
    } catch {
      return null;
    }
  }

  function disposeMeter(meter) {
    meter?.source.disconnect();
    meter?.analyser.disconnect();
  }

  function aboveThreshold(meter) {
    if (!meter || context?.state !== 'running') return false;
    meter.analyser.getFloatTimeDomainData(meter.samples);
    let energy = 0;
    for (const sample of meter.samples) energy += sample * sample;
    return Math.sqrt(energy / meter.samples.length) > 0.025;
  }

  function play(peer) {
    try {
      peer.audio.play()?.catch(() => {});
    } catch {
      // A later state update retries playback if autoplay was blocked.
    }
  }

  let volume = 1;
  function applyGates() {
    if (micTrack) micTrack.enabled = !mutedByRole();
    for (const peer of peers.values()) {
      peer.audio.muted = !audible(peer.id);
      peer.audio.volume = volume;
      if (!peer.closed && peer.audio.srcObject && peer.audio.paused) play(peer);
    }
  }

  function closePeer(peer) {
    peer.closed = true;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    disposeMeter(peer.meter);
    peer.meter = null;
    peer.audio.pause();
    peer.audio.srcObject = null;
    peer.audio.remove();
  }

  function fail(peer) {
    if (!live(peer)) return;
    peer.status = 'failed';
    closePeer(peer);
  }

  function enqueue(peer, work) {
    peer.pending = peer.pending.then(async () => {
      if (live(peer)) await work();
    }).catch(() => fail(peer));
    return peer.pending;
  }

  async function attachMic(peer) {
    const transceiver = peer.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
    if (!transceiver) return;
    transceiver.direction = 'sendrecv';
    if (transceiver.sender.track !== micTrack) {
      await transceiver.sender.replaceTrack(micTrack);
    }
  }

  function offer(peer) {
    return enqueue(peer, async () => {
      if (state?.you >= peer.id || state?.you == null || peer.pc.signalingState !== 'stable') return;
      try {
        peer.makingOffer = true;
        if (!peer.pc.getTransceivers().length) {
          peer.pc.addTransceiver('audio', { direction: 'sendrecv' });
        }
        await attachMic(peer);
        await peer.pc.setLocalDescription(await peer.pc.createOffer());
        signal(peer, { description: peer.pc.localDescription });
      } finally {
        peer.makingOffer = false;
      }
    });
  }

  function createPeer(id) {
    if (typeof RTCPeerConnection === 'undefined') return null;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.hidden = true;
    audio.muted = !audible(id);
    document.body.appendChild(audio);
    const peer = {
      id, pc, audio, meter: null, closed: false, status: 'connecting',
      pending: Promise.resolve(), candidates: [], makingOffer: false, ignoreOffer: false,
    };
    peers.set(id, peer);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        try { signal(peer, { candidate: candidate.toJSON() }); } catch { fail(peer); }
      }
    };
    pc.ontrack = ({ track, streams }) => {
      if (!live(peer)) return;
      const remote = streams[0] || new MediaStream([track]);
      disposeMeter(peer.meter);
      peer.meter = meterFor(remote);
      audio.srcObject = remote;
      audio.muted = !audible(id);
      play(peer);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail(peer);
      else peer.status = pc.connectionState === 'connected' ? 'connected' : 'connecting';
    };
    pc.onnegotiationneeded = () => {
      if (state?.you < id) offer(peer);
    };
    return peer;
  }

  function handleSignal(msg) {
    if (!ready || msg?.t !== 'rtc' || !Number.isInteger(msg.from)
      || msg.from === state?.you || !msg.data) return;
    let peer = peers.get(msg.from);
    if (msg.data.restart && state?.you < msg.from) {
      if (peer) closePeer(peer);
      peers.delete(msg.from);
      peer = createPeer(msg.from);
      if (peer) offer(peer);
      return;
    }
    if (!peer || peer.closed) peer = createPeer(msg.from);
    if (!peer) return;
    const { description, candidate } = msg.data;
    enqueue(peer, async () => {
      if (description) {
        if (!['offer', 'answer'].includes(description.type)) return;
        const collision = description.type === 'offer'
          && (peer.makingOffer || peer.pc.signalingState !== 'stable');
        const polite = state?.you == null || state.you > peer.id;
        peer.ignoreOffer = !polite && collision;
        if (peer.ignoreOffer) return;
        if (collision && peer.pc.signalingState !== 'stable') {
          await peer.pc.setLocalDescription({ type: 'rollback' });
        }
        await peer.pc.setRemoteDescription(description);
        await attachMic(peer);
        for (const queued of peer.candidates.splice(0)) {
          await peer.pc.addIceCandidate(queued);
        }
        if (description.type === 'offer') {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          signal(peer, { description: peer.pc.localDescription });
        }
      } else if (candidate && !peer.ignoreOffer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
        else peer.candidates.push(candidate);
      }
    });
  }

  function start() {
    if (starting) return starting;
    const current = ++generation;
    starting = (async () => {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          context = new AudioContext();
          context.resume().catch(() => {});
        }
      } catch {
        context = null;
      }
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          micState = 'unavailable';
        } else {
          const acquired = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
          if (generation !== current) {
            acquired.getTracks().forEach((track) => track.stop());
            return;
          }
          stream = acquired;
          micTrack = stream.getAudioTracks()[0] || null;
          micState = micTrack ? 'on' : 'unavailable';
          localMeter = meterFor(stream);
          if (micTrack) micTrack.onended = () => { micState = 'unavailable'; };
        }
      } catch (error) {
        if (generation !== current) return;
        micState = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)
          ? 'denied' : 'unavailable';
      }
      if (generation === current) ready = true;
    })().catch(() => {
      if (generation === current) {
        micState = 'unavailable';
        ready = true;
      }
    });
    return starting;
  }

  function update(nextState) {
    if (!ready) return;
    state = nextState;
    applyGates();
    const ids = new Set(state.players.filter((p) => p.id !== state.you).map((p) => p.id));
    for (const [id, peer] of peers) {
      if (!ids.has(id)) {
        closePeer(peer);
        peers.delete(id);
      }
    }
    for (const id of ids) {
      let peer = peers.get(id);
      const retry = peer?.closed;
      if (!peer || retry) {
        peer = createPeer(id);
        if (!peer) continue;
        if (state.you < id) offer(peer);
        else if (retry) {
          try { signal(peer, { restart: true }); } catch { fail(peer); }
        }
      } else if (state.you < id && !peer.pc.localDescription && !peer.pc.remoteDescription) {
        offer(peer);
      }
    }
  }

  function status() {
    return {
      mic: micState === 'on' && mutedByRole() ? 'muted-by-role' : micState,
      deafened: deafened(),
      peers: Object.fromEntries([...peers].map(([id, peer]) => [id, peer.status])),
    };
  }

  function speaking() {
    const ids = new Set();
    if (!ready) return ids;
    if (state && micState === 'on' && micTrack?.enabled && aboveThreshold(localMeter)) ids.add(state.you);
    for (const [id, peer] of peers) {
      if (audible(id) && !peer.audio.muted && !peer.audio.paused && aboveThreshold(peer.meter)) ids.add(id);
    }
    return ids;
  }

  function stop() {
    generation++;
    ready = false;
    starting = null;
    for (const peer of peers.values()) closePeer(peer);
    peers.clear();
    stream?.getTracks().forEach((track) => track.stop());
    disposeMeter(localMeter);
    context?.close().catch(() => {});
    context = null;
    localMeter = null;
    stream = null;
    micTrack = null;
    micState = 'unavailable';
    state = null;
  }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    applyGates();
  }

  return { start, handleSignal, update, status, speaking, stop, setVolume };
}
