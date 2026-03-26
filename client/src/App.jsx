import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || 'http://localhost:3001'

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

const EMOJIS = ['😀', '😂', '😍', '👍', '🙏', '🔥', '❤️', '🎉']
const QUICK_MESSAGES = [
  'Hi 👋',
  'How are you?',
  'Nice to meet you!',
  'Can you hear me?',
  'One sec please',
]

function App() {
  const [status, setStatus] = useState('Ready to start')
  const [connected, setConnected] = useState(false)
  const [inCall, setInCall] = useState(false)
  const [isStrangerConnecting, setIsStrangerConnecting] = useState(false)
  const [isWaitingForMatch, setIsWaitingForMatch] = useState(false)
  const [autoSearch, setAutoSearch] = useState(true)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [localNetwork, setLocalNetwork] = useState({ label: 'Checking', level: 2 })
  const [remoteNetwork, setRemoteNetwork] = useState({ label: 'Waiting', level: 0 })

  const socketRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerRef = useRef(null)
  const localStreamRef = useRef(null)
  const roomIdRef = useRef(null)
  const autoSearchRef = useRef(true)
  const pendingIceCandidatesRef = useRef([])
  const isRematchingRef = useRef(false)
  const chatBottomRef = useRef(null)
  const statsIntervalRef = useRef(null)
  const lastVideoBytesRef = useRef({ bytes: 0, timestamp: 0 })
  const currentQualityRef = useRef('high')

  const clearChat = () => {
    setChatMessages([])
    setChatInput('')
  }

  const getNetworkClass = (level) => {
    if (level >= 4) return 'strong'
    if (level === 3) return 'good'
    if (level === 2) return 'fair'
    if (level === 1) return 'poor'
    return 'none'
  }

  const stopStatsMonitoring = () => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current)
      statsIntervalRef.current = null
    }
    lastVideoBytesRef.current = { bytes: 0, timestamp: 0 }
  }

  const applyAdaptiveQuality = (profile) => {
    if (!peerRef.current || currentQualityRef.current === profile) {
      return
    }

    const videoSender = peerRef.current.getSenders().find((sender) => sender.track?.kind === 'video')
    if (!videoSender?.getParameters || !videoSender?.setParameters) {
      return
    }

    const params = videoSender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}]
    }

    const encoding = params.encodings[0]
    if (profile === 'low') {
      encoding.maxBitrate = 250000
      encoding.maxFramerate = 15
      encoding.scaleResolutionDownBy = 2
    } else if (profile === 'medium') {
      encoding.maxBitrate = 550000
      encoding.maxFramerate = 20
      encoding.scaleResolutionDownBy = 1.4
    } else {
      encoding.maxBitrate = 1200000
      encoding.maxFramerate = 30
      encoding.scaleResolutionDownBy = 1
    }

    currentQualityRef.current = profile
    videoSender.setParameters(params).catch(() => {
      currentQualityRef.current = profile
    })
  }

  const startStatsMonitoring = () => {
    stopStatsMonitoring()

    if (!peerRef.current) {
      return
    }

    statsIntervalRef.current = setInterval(async () => {
      if (!peerRef.current) {
        return
      }

      const stats = await peerRef.current.getStats()
      let inboundVideo = null
      let selectedPair = null

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video' && !report.isRemote) {
          inboundVideo = report
        }
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          report.nominated
        ) {
          selectedPair = report
        }
      })

      if (!inboundVideo) {
        return
      }

      const nowBytes = inboundVideo.bytesReceived || 0
      const nowTimestamp = inboundVideo.timestamp || 0
      const previous = lastVideoBytesRef.current

      let bitrateKbps = 0
      if (previous.timestamp > 0 && nowTimestamp > previous.timestamp) {
        bitrateKbps = ((nowBytes - previous.bytes) * 8) / (nowTimestamp - previous.timestamp)
      }
      lastVideoBytesRef.current = { bytes: nowBytes, timestamp: nowTimestamp }

      const packetsLost = inboundVideo.packetsLost || 0
      const packetsReceived = inboundVideo.packetsReceived || 0
      const packetLossRatio = packetsReceived + packetsLost > 0
        ? packetsLost / (packetsReceived + packetsLost)
        : 0

      const jitterMs = (inboundVideo.jitter || 0) * 1000
      const rttMs = ((selectedPair && selectedPair.currentRoundTripTime) || 0) * 1000

      let level = 4
      if (bitrateKbps < 220) level -= 1
      if (packetLossRatio > 0.08) level -= 1
      if (jitterMs > 120) level -= 1
      if (rttMs > 450) level -= 1
      level = Math.max(0, Math.min(4, level))

      const labelMap = ['No Signal', 'Poor', 'Fair', 'Good', 'Strong']
      setRemoteNetwork({ label: labelMap[level], level })

      if (level <= 1) {
        applyAdaptiveQuality('low')
      } else if (level === 2) {
        applyAdaptiveQuality('medium')
      } else {
        applyAdaptiveQuality('high')
      }
    }, 2000)
  }

  const cleanupPeer = ({ clearRoom = true } = {}) => {
    if (peerRef.current) {
      peerRef.current.onicecandidate = null
      peerRef.current.ontrack = null
      peerRef.current.onconnectionstatechange = null
      peerRef.current.close()
      peerRef.current = null
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }

    pendingIceCandidatesRef.current = []
    setIsStrangerConnecting(false)
    setIsWaitingForMatch(false)
    setRemoteNetwork({ label: 'Waiting', level: 0 })
    stopStatsMonitoring()
    if (clearRoom) {
      roomIdRef.current = null
    }
    setInCall(false)
  }

  const requestMatch = () => {
    isRematchingRef.current = false
    if (!socketRef.current?.connected) {
      setStatus('Socket disconnected. Reconnecting...')
      return
    }
    setStatus('Searching for a random user...')
    setIsWaitingForMatch(true)
    clearChat()
    socketRef.current.emit('join-random')
  }

  const handlePeerGone = (reason) => {
    cleanupPeer()
    clearChat()
    setStatus(reason)
    if (autoSearchRef.current) {
      requestMatch()
    }
  }

  const rematchNow = (reason) => {
    if (isRematchingRef.current) {
      return
    }

    isRematchingRef.current = true
    cleanupPeer()
    clearChat()
    setStatus(reason)

    if (socketRef.current?.connected) {
      socketRef.current.emit('next-user')
    }
  }

  const createPeerConnection = async (initiator) => {
    if (!localStreamRef.current || !socketRef.current) {
      return
    }

    setIsStrangerConnecting(true)
    cleanupPeer({ clearRoom: false })
    setIsStrangerConnecting(true)
    setRemoteNetwork({ label: 'Connecting', level: 1 })

    const peer = new RTCPeerConnection(rtcConfig)
    peerRef.current = peer

    localStreamRef.current.getTracks().forEach((track) => {
      peer.addTrack(track, localStreamRef.current)
    })

    peer.ontrack = (event) => {
      const [stream] = event.streams
      if (stream && localStreamRef.current && stream.id === localStreamRef.current.id) {
        rematchNow('Sync issue detected. Connecting to a new user...')
        return
      }

      if (remoteVideoRef.current && stream) {
        remoteVideoRef.current.srcObject = stream
        setIsStrangerConnecting(false)
        remoteVideoRef.current.play().catch(() => {
          setStatus('Connected. Click the page once if remote audio is blocked.')
        })
      }
    }

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setIsStrangerConnecting(false)
        setStatus('You are now connected with a stranger')
        startStatsMonitoring()
      }

      if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
        setRemoteNetwork({ label: 'Poor', level: 1 })
      }
    }

    peer.onicecandidate = (event) => {
      if (!event.candidate || !roomIdRef.current) {
        return
      }
      socketRef.current.emit('signal', {
        roomId: roomIdRef.current,
        signal: { candidate: event.candidate },
      })
    }

    if (initiator) {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      socketRef.current.emit('signal', {
        roomId: roomIdRef.current,
        signal: { description: peer.localDescription },
      })
    }

    setInCall(true)
    startStatsMonitoring()
  }

  useEffect(() => {
    let mounted = true

    const setupMediaAndSocket = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        })

        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        localStreamRef.current = stream
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }

        const socket = io(SIGNAL_URL, {
          transports: ['websocket'],
          autoConnect: true,
        })
        socketRef.current = socket

        socket.on('connect', () => {
          setConnected(true)
          setStatus('Connected to server')
          socket.emit('set-auto-search', { enabled: autoSearchRef.current })
          if (autoSearchRef.current && !roomIdRef.current) {
            requestMatch()
          }
        })

        socket.on('disconnect', () => {
          setConnected(false)
          setStatus('Server disconnected. Trying to reconnect...')
          cleanupPeer()
        })

        socket.on('waiting', () => {
          setStatus('Waiting for someone to connect...')
          setIsWaitingForMatch(true)
          setIsStrangerConnecting(false)
        })

        socket.on('matched', async ({ roomId, initiator }) => {
          roomIdRef.current = roomId
          clearChat()
          setIsWaitingForMatch(false)
          setIsStrangerConnecting(true)
          setStatus('Connected! Starting call...')
          await createPeerConnection(initiator)
        })

        socket.on('signal', async ({ signal }) => {
          if (!peerRef.current) {
            return
          }

          if (signal.description) {
            await peerRef.current.setRemoteDescription(signal.description)

            while (pendingIceCandidatesRef.current.length > 0) {
              const candidate = pendingIceCandidatesRef.current.shift()
              await peerRef.current.addIceCandidate(candidate)
            }

            if (signal.description.type === 'offer') {
              const answer = await peerRef.current.createAnswer()
              await peerRef.current.setLocalDescription(answer)
              socket.emit('signal', {
                roomId: roomIdRef.current,
                signal: { description: peerRef.current.localDescription },
              })
            }
          }

          if (signal.candidate) {
            try {
              if (peerRef.current.remoteDescription) {
                await peerRef.current.addIceCandidate(signal.candidate)
              } else {
                pendingIceCandidatesRef.current.push(signal.candidate)
              }
            } catch {
              setStatus('Network change detected, syncing call...')
            }
          }
        })

        socket.on('peer-left', () => {
          handlePeerGone('Peer left the chat')
        })

        socket.on('peer-next', () => {
          handlePeerGone('Peer switched to next user')
        })

        socket.on('peer-disconnected', () => {
          handlePeerGone('Peer disconnected')
        })

        socket.on('chat-message', ({ message, createdAt }) => {
          setChatMessages((prev) => [
            ...prev,
            {
              id: `${createdAt || Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              sender: 'stranger',
              text: message,
            },
          ])
        })
      } catch {
        setStatus('Camera or microphone access failed')
      }
    }

    setupMediaAndSocket()

    return () => {
      mounted = false
      cleanupPeer()

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop())
      }

      if (socketRef.current) {
        socketRef.current.disconnect()
      }
    }
  }, [])

  useEffect(() => {
    autoSearchRef.current = autoSearch
    if (socketRef.current?.connected) {
      socketRef.current.emit('set-auto-search', { enabled: autoSearch })
    }
  }, [autoSearch])

  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages])

  useEffect(() => {
    const network = navigator.connection || navigator.mozConnection || navigator.webkitConnection
    if (!network) {
      setLocalNetwork({ label: 'Unknown', level: 2 })
      return
    }

    const updateLocalNetwork = () => {
      const effectiveType = network.effectiveType || ''
      const downlink = typeof network.downlink === 'number' ? network.downlink : 0

      let level = 2
      let label = 'Fair'

      if (effectiveType === '4g' && downlink >= 5) {
        level = 4
        label = 'Strong'
      } else if (effectiveType === '4g' || downlink >= 2) {
        level = 3
        label = 'Good'
      } else if (effectiveType === '3g' || downlink >= 0.9) {
        level = 2
        label = 'Fair'
      } else if (effectiveType === '2g' || effectiveType === 'slow-2g' || downlink < 0.9) {
        level = 1
        label = 'Poor'
      }

      setLocalNetwork({ label, level })
    }

    updateLocalNetwork()
    network.addEventListener('change', updateLocalNetwork)

    return () => {
      network.removeEventListener('change', updateLocalNetwork)
    }
  }, [])

  const onLeave = () => {
    cleanupPeer()
    clearChat()
    if (socketRef.current?.connected) {
      socketRef.current.emit('leave-room')
    }
    setStatus('You left the chat')
  }

  const onNext = () => {
    cleanupPeer()
    clearChat()
    if (socketRef.current?.connected) {
      socketRef.current.emit('next-user')
      setStatus('Finding next random user...')
    }
  }

  const sendChatMessage = (rawMessage) => {
    const trimmed = rawMessage.trim()
    if (!trimmed || !roomIdRef.current || !socketRef.current?.connected || !inCall) {
      return false
    }

    const message = trimmed.slice(0, 500)
    const now = Date.now()
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
        sender: 'you',
        text: message,
      },
    ])

    socketRef.current.emit('chat-message', {
      roomId: roomIdRef.current,
      message,
    })

    return true
  }

  const onSendMessage = (event) => {
    event.preventDefault()
    if (sendChatMessage(chatInput)) {
      setChatInput('')
    }
  }

  const onQuickMessage = (message) => {
    sendChatMessage(message)
  }

  const onPickEmoji = (emoji) => {
    setChatInput((prev) => `${prev}${emoji}`.slice(0, 500))
  }

  return (
    <main className="app">
      <section className="panel header-panel">
        <h1>Random Video Chat</h1>
        <p>{status}</p>
        <div className="status-row">
          <span className={connected ? 'dot online' : 'dot offline'}></span>
          <span>{connected ? 'Server Online' : 'Server Offline'}</span>
        </div>
      </section>

      <div className="content-layout">
        <div className="left-column">
          <section className="videos">
            <div className="video-card">
              <h2>You</h2>
              <div className="video-frame">
                <video ref={localVideoRef} autoPlay muted playsInline />
                <div
                  className={`network-strength ${getNetworkClass(localNetwork.level)}`}
                  aria-label={`Your network ${localNetwork.label}`}
                  title={`Your network: ${localNetwork.label}`}
                >
                  <span className="network-bars" aria-hidden="true">
                    {[1, 2, 3, 4].map((bar) => (
                      <span key={bar} className={localNetwork.level >= bar ? 'active' : ''}></span>
                    ))}
                  </span>
                </div>
              </div>
            </div>
            <div
              className={`video-card stranger-card ${
                isStrangerConnecting ? 'connecting' : isWaitingForMatch ? 'waiting' : ''
              }`}
            >
              <h2>Stranger</h2>
              {(isStrangerConnecting || isWaitingForMatch) && (
                <span className="connecting-label">
                  {isStrangerConnecting ? 'Connecting...' : 'Waiting for user...'}
                </span>
              )}
              <div className="video-frame">
                <video ref={remoteVideoRef} autoPlay playsInline />
                <div
                  className={`network-strength ${getNetworkClass(remoteNetwork.level)}`}
                  aria-label={`Stranger network ${remoteNetwork.label}`}
                  title={`Stranger network: ${remoteNetwork.label}`}
                >
                  <span className="network-bars" aria-hidden="true">
                    {[1, 2, 3, 4].map((bar) => (
                      <span key={bar} className={remoteNetwork.level >= bar ? 'active' : ''}></span>
                    ))}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="panel controls">
            <div className="buttons">
              <button onClick={requestMatch}>Start</button>
              <button onClick={onNext} disabled={!connected}>Next</button>
              <button onClick={onLeave} disabled={!inCall}>Leave</button>
            </div>
            <label className="auto-search">
              <input
                type="checkbox"
                checked={autoSearch}
                onChange={(event) => setAutoSearch(event.target.checked)}
              />
              Auto-search when peer disconnects
            </label>
          </section>

          <section className="panel tips">
            <h3>How it works</h3>
            <ul>
              <li>Press Start to enter the random queue.</li>
              <li>Press Next to switch instantly to another user.</li>
              <li>Press Leave to end the current chat.</li>
              <li>When auto-search is enabled, disconnections trigger a new match.</li>
            </ul>
          </section>
        </div>

        <section className="panel chat-panel">
          <h3>Chat</h3>
          <div className="chat-list" aria-live="polite">
            {chatMessages.length === 0 ? (
              <p className="chat-empty">No messages yet. Say hi when connected.</p>
            ) : (
              chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`chat-bubble ${msg.sender === 'you' ? 'you' : 'stranger'}`}
                >
                  {msg.text}
                </div>
              ))
            )}
            <div ref={chatBottomRef}></div>
          </div>

          <form className="chat-form" onSubmit={onSendMessage}>
            <input
              type="text"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder={inCall ? 'Type a message...' : 'Connect to start chatting'}
              disabled={!inCall}
              maxLength={500}
            />
            <button type="submit" disabled={!inCall || !chatInput.trim()}>
              Send
            </button>
          </form>

          <div className="emoji-row" aria-label="Emoji shortcuts">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onPickEmoji(emoji)}
                disabled={!inCall}
              >
                {emoji}
              </button>
            ))}
          </div>

          <div className="quick-row" aria-label="Quick messages">
            {QUICK_MESSAGES.map((message) => (
              <button
                key={message}
                type="button"
                onClick={() => onQuickMessage(message)}
                disabled={!inCall}
              >
                {message}
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
