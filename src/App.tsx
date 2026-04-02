/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Timer, 
  Activity, 
  Zap, 
  Play, 
  Square, 
  Settings, 
  MapPin, 
  AlertTriangle,
  Info,
  ChevronRight,
  Vibrate
} from 'lucide-react';

// Utility to convert pace (min/km) to speed (m/s)
const paceToSpeed = (minutes: number, seconds: number): number => {
  const totalSeconds = (minutes * 60) + seconds;
  if (totalSeconds === 0) return 0;
  return 1000 / totalSeconds;
};

// Utility to convert speed (m/s) back to pace (min/km)
const speedToPace = (speedMs: number): { min: number; sec: number } => {
  if (speedMs <= 0) return { min: 0, sec: 0 };
  const totalSeconds = 1000 / speedMs;
  const min = Math.floor(totalSeconds / 60);
  const sec = Math.round(totalSeconds % 60);
  return { min, sec };
};

// Utility to format pace string
const formatPace = (min: number, sec: number) => {
  return `${min}:${sec.toString().padStart(2, '0')}`;
};

export default function App() {
  // State
  const [minInput, setMinInput] = useState<number>(5);
  const [secInput, setSecInput] = useState<number>(0);
  const [isRunning, setIsRunning] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isGracePeriod, setIsGracePeriod] = useState(false);
  const [useSound, setUseSound] = useState(true);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  const [stats, setStats] = useState<{
    distance: number;
    duration: number;
    avgPace: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVibrating, setIsVibrating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [smoothingFactor, setSmoothingFactor] = useState(0.4);
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);
  const [permissions, setPermissions] = useState<{
    location: PermissionState | 'unknown';
    notifications: NotificationPermission | 'unknown';
  }>({
    location: 'unknown',
    notifications: 'unknown'
  });
  
  // Refs for tracking and state sync in callbacks
  const isRunningRef = useRef(false);
  const isGracePeriodRef = useRef(false);
  const isVibratingRef = useRef(false);
  const targetSpeedRef = useRef(0);
  const watchId = useRef<number | null>(null);
  const vibrationInterval = useRef<number | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  
  // Stats tracking refs
  const startTime = useRef<number | null>(null);
  const totalDistance = useRef<number>(0);
  const lastPosition = useRef<GeolocationCoordinates | null>(null);
  const smoothedSpeed = useRef<number | null>(null);
  const speedHistory = useRef<number[]>([]);

  // Simple Exponential Moving Average for speed smoothing
  const updateSmoothedSpeed = (newSpeed: number | null) => {
    if (newSpeed === null) return null;
    if (smoothedSpeed.current === null) {
      smoothedSpeed.current = newSpeed;
    } else {
      smoothedSpeed.current = (smoothingFactor * newSpeed) + ((1 - smoothingFactor) * smoothedSpeed.current);
    }
    return smoothedSpeed.current;
  };

  // Haversine distance calculation
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in meters
  };

  // Sync refs with state
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    isGracePeriodRef.current = isGracePeriod;
  }, [isGracePeriod]);

  useEffect(() => {
    isVibratingRef.current = isVibrating;
  }, [isVibrating]);

  // Target speed in m/s
  const targetSpeed = paceToSpeed(minInput, secInput);
  useEffect(() => {
    targetSpeedRef.current = targetSpeed;
  }, [targetSpeed]);

  // Check permissions on mount
  useEffect(() => {
    if ('permissions' in navigator) {
      try {
        navigator.permissions.query({ name: 'geolocation' as PermissionName }).then(status => {
          setPermissions(prev => ({ ...prev, location: status.state }));
          status.onchange = () => setPermissions(prev => ({ ...prev, location: status.state }));
        }).catch(err => console.error("Erro ao consultar permissão de GPS:", err));
      } catch (err) {
        console.error("Navegador não suporta consulta de permissão de GPS:", err);
      }
    }
    
    if ('Notification' in window) {
      setPermissions(prev => ({ ...prev, notifications: Notification.permission }));
    }
  }, []);

  // Request Wake Lock to keep screen on
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        const lock = await navigator.wakeLock.request('screen');
        setWakeLock(lock);
        lock.addEventListener('release', () => {
          console.log('Wake Lock was released');
        });
      }
    } catch (err: any) {
      console.error(`${err.name}, ${err.message}`);
    }
  };

  // Release Wake Lock
  const releaseWakeLock = useCallback(() => {
    if (wakeLock) {
      wakeLock.release();
      setWakeLock(null);
    }
  }, [wakeLock]);

  // Handle Vibration and Sound
  const playBeep = useCallback(() => {
    if (!useSound) return;
    try {
      if (!audioContext.current) {
        audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContext.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
      
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.01);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
      console.error("Audio error:", e);
    }
  }, [useSound]);

  const startVibration = useCallback(() => {
    if (!isVibratingRef.current) {
      setIsVibrating(true);
      isVibratingRef.current = true;
      
      // Vibrate pattern: 500ms on, 500ms off
      // We use a recursive timeout for better background reliability than setInterval
      const vibrateLoop = () => {
        if (!isVibratingRef.current) return;
        
        if ('vibrate' in navigator) {
          navigator.vibrate(500);
        }
        playBeep();
        
        vibrationInterval.current = window.setTimeout(vibrateLoop, 1000);
      };
      
      vibrateLoop();
    }
  }, [playBeep]);

  const stopVibration = useCallback(() => {
    setIsVibrating(false);
    isVibratingRef.current = false;
    if (vibrationInterval.current) {
      clearTimeout(vibrationInterval.current);
      vibrationInterval.current = null;
    }
    if ('vibrate' in navigator) {
      navigator.vibrate(0);
    }
  }, []);

  // Start Tracking
  const startTracking = async () => {
    // Request Notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
        setPermissions(prev => ({ ...prev, notifications: Notification.permission }));
      } catch (err) {
        console.error("Erro ao solicitar permissão de notificação:", err);
      }
    }

    if (!navigator.geolocation) {
      setError("Seu navegador não suporta GPS.");
      return;
    }

    // Explicitly request GPS if not granted
    try {
      await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject);
      });
    } catch (err) {
      console.error("Erro ao obter localização inicial:", err);
      setError("Permissão de GPS necessária para monitorar o ritmo.");
      return;
    }

    setError(null);
    
    // Start 5s countdown
    setCountdown(5);
    const countdownInterval = window.setInterval(() => {
      setCountdown(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(countdownInterval);
          initTracking();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const initTracking = () => {
    setIsRunning(true);
    isRunningRef.current = true;
    setIsGracePeriod(true);
    isGracePeriodRef.current = true;
    setStats(null);
    
    // Reset stats
    startTime.current = Date.now();
    totalDistance.current = 0;
    lastPosition.current = null;
    smoothedSpeed.current = null;
    
    requestWakeLock();

    // 5s Grace period for acceleration
    setTimeout(() => {
      setIsGracePeriod(false);
      isGracePeriodRef.current = false;
    }, 5000);

    // Send start notification
    if (Notification.permission === 'granted') {
      new Notification("DengosPace", {
        body: "Monitoramento iniciado. Mantenha o ritmo!",
        icon: "/favicon.ico",
        silent: true
      });
    }

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        // Guard: check if we are still supposed to be running
        if (!isRunningRef.current) return;

        const rawSpeed = position.coords.speed; // speed in m/s
        const speed = updateSmoothedSpeed(rawSpeed);
        setCurrentSpeed(speed);

        // Update distance
        if (lastPosition.current) {
          const dist = calculateDistance(
            lastPosition.current.latitude,
            lastPosition.current.longitude,
            position.coords.latitude,
            position.coords.longitude
          );
          // Filter out GPS jumps (e.g. > 30m in 1s is likely error)
          if (dist < 30) {
            totalDistance.current += dist;
          }
        }
        lastPosition.current = position.coords;

        if (speed !== null && !isGracePeriodRef.current) {
          if (speed < targetSpeedRef.current) {
            // Notify if below target
            if (Notification.permission === 'granted' && !isVibratingRef.current) {
              new Notification("DengosPace", {
                body: "Você está abaixo do ritmo! Acelere!",
                silent: true,
                tag: 'pace-alert',
                renotify: true
              } as any);
            }
            startVibration();
          } else {
            if (isVibratingRef.current && Notification.permission === 'granted') {
              new Notification("DengosPace", {
                body: "Ritmo recuperado!",
                silent: true,
                tag: 'pace-alert',
                renotify: true
              } as any);
            }
            stopVibration();
          }
        }
      },
      (err) => {
        console.error(err);
        setError("Erro ao acessar GPS. Verifique as permissões.");
        stopTracking();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000
      }
    );
  };

  // Stop Tracking
  const stopTracking = useCallback(() => {
    const endTime = Date.now();
    const durationMs = startTime.current ? endTime - startTime.current : 0;
    const durationSec = Math.floor(durationMs / 1000);
    const distanceKm = totalDistance.current / 1000;
    
    // Calculate average pace
    let avgPaceStr = "0:00";
    if (distanceKm > 0.05) { // Only if moved more than 50m
      const totalMin = (durationMs / 1000) / 60;
      const paceDecimal = totalMin / distanceKm;
      const pMin = Math.floor(paceDecimal);
      const pSec = Math.round((paceDecimal - pMin) * 60);
      avgPaceStr = formatPace(pMin, pSec);
    }

    const finalStats = {
      distance: Number(distanceKm.toFixed(2)),
      duration: durationSec,
      avgPace: avgPaceStr
    };

    setStats(finalStats);
    setIsRunning(false);
    isRunningRef.current = false;
    setIsGracePeriod(false);
    isGracePeriodRef.current = false;
    setCountdown(null);
    setCurrentSpeed(null);
    stopVibration();
    releaseWakeLock();

    // Send stop notification
    if (Notification.permission === 'granted') {
      new Notification("DengosPace", {
        body: `Treino finalizado. ${finalStats.distance}km em ${finalStats.avgPace} min/km.`,
        silent: true,
        tag: 'pace-alert'
      });
    }

    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
  }, [stopVibration, releaseWakeLock]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
      }
      if (vibrationInterval.current) {
        clearInterval(vibrationInterval.current);
      }
      if (audioContext.current) {
        audioContext.current.close();
      }
      releaseWakeLock();
    };
  }, [releaseWakeLock]);

  return (
    <div className="min-h-screen overflow-y-auto touch-pan-y bg-neutral-950 text-white font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="p-6 flex justify-between items-center border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
            <Zap className="w-5 h-5 text-black fill-current" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">DengosPace</h1>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setUseSound(!useSound)}
            className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter transition-colors ${
              useSound ? 'bg-emerald-500 text-black' : 'bg-neutral-800 text-neutral-500'
            }`}
          >
            {useSound ? 'Som Ativo' : 'Som Mudo'}
          </button>
          {permissions.notifications === 'granted' ? (
            <div className="w-2 h-2 rounded-full bg-emerald-500" title="Notificações Ativas" />
          ) : (
            <div className="w-2 h-2 rounded-full bg-neutral-700" title="Notificações Desativadas" />
          )}
          <button 
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-white/5 rounded-full transition-colors"
          >
            <Settings className="w-5 h-5 text-neutral-400" />
          </button>
        </div>
      </header>

      <main className="max-w-md mx-auto p-6 space-y-8 pb-40">
        {/* Permission Warnings */}
        {permissions.location === 'denied' && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-2xl p-4 flex gap-3 text-red-200 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <p>O acesso ao GPS foi negado. Por favor, habilite nas configurações do navegador para usar o app.</p>
          </div>
        )}

        {/* Pace Input Section - Hidden when running */}
        {!isRunning && countdown === null && (
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-neutral-400 text-sm font-medium uppercase tracking-wider">
              <Timer className="w-4 h-4" />
              <span>Ritmo Alvo (min/km)</span>
            </div>
            
            <div className="bg-neutral-900/50 border border-white/10 rounded-3xl p-8 flex flex-col items-center justify-center gap-4">
              <div className="flex items-baseline gap-2">
                <input 
                  type="number" 
                  value={minInput}
                  onChange={(e) => setMinInput(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-24 text-6xl font-black text-center bg-transparent border-b-2 border-emerald-500/30 focus:border-emerald-500 outline-none transition-colors"
                />
                <span className="text-4xl font-bold text-neutral-600">:</span>
                <input 
                  type="number" 
                  value={secInput}
                  onChange={(e) => setSecInput(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                  className="w-24 text-6xl font-black text-center bg-transparent border-b-2 border-emerald-500/30 focus:border-emerald-500 outline-none transition-colors"
                />
              </div>
              <p className="text-neutral-500 text-sm">
                Equivale a {(targetSpeed * 3.6).toFixed(1)} km/h
              </p>
            </div>
          </section>
        )}

        {/* Countdown UI */}
        {countdown !== null && (
          <motion.div 
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center justify-center py-12"
          >
            <span className="text-neutral-500 text-sm font-bold uppercase tracking-widest mb-4">Prepare-se</span>
            <div className="text-9xl font-black text-emerald-500 drop-shadow-[0_0_30px_rgba(16,185,129,0.5)]">
              {countdown}
            </div>
          </motion.div>
        )}

        {/* Status Section */}
        <AnimatePresence mode="wait">
          {isRunning ? (
            <motion.section 
              key="active"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className={`rounded-3xl p-8 border-2 transition-all duration-500 ${
                isGracePeriod
                  ? 'bg-blue-500/10 border-blue-500 shadow-[0_0_40px_-10px_rgba(59,130,246,0.3)]'
                  : isVibrating 
                    ? 'bg-red-500/10 border-red-500 shadow-[0_0_40px_-10px_rgba(239,68,68,0.3)]' 
                    : 'bg-emerald-500/10 border-emerald-500 shadow-[0_0_40px_-10px_rgba(16,185,129,0.3)]'
              }`}>
                <div className="flex flex-col items-center text-center gap-2">
                  <span className="text-sm font-bold uppercase tracking-widest opacity-60">
                    {isGracePeriod ? 'Acelerando...' : isVibrating ? 'Abaixo da Meta' : 'No Ritmo'}
                  </span>
                  
                  <div className="text-8xl font-black tabular-nums">
                    {currentSpeed !== null 
                      ? formatPace(speedToPace(currentSpeed).min, speedToPace(currentSpeed).sec)
                      : '--:--'}
                  </div>
                  
                  <div className="flex items-center gap-4 text-neutral-400 font-medium">
                    <span>Ritmo Atual</span>
                    <span className="text-neutral-600">|</span>
                    <span className="text-emerald-500/80">Meta: {formatPace(minInput, secInput)}</span>
                  </div>
                </div>

                {isVibrating && !isGracePeriod && (
                  <motion.div 
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ repeat: Infinity, duration: 0.5 }}
                    className="mt-6 flex items-center justify-center gap-2 text-red-500 font-bold"
                  >
                    <Vibrate className="w-5 h-5" />
                    <span>ACELERE!</span>
                  </motion.div>
                )}

                {isGracePeriod && (
                  <div className="mt-6 flex flex-col items-center gap-2">
                    <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: "0%" }}
                        animate={{ width: "100%" }}
                        transition={{ duration: 5, ease: "linear" }}
                        className="h-full bg-blue-500"
                      />
                    </div>
                    <span className="text-[10px] text-blue-400 font-bold uppercase tracking-widest">Período de Aceleração</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="bg-neutral-900 border border-white/5 rounded-2xl p-3">
                  <div className="text-neutral-500 text-[10px] uppercase font-bold mb-1">Velocidade</div>
                  <div className="text-lg font-bold">
                    {currentSpeed !== null ? (currentSpeed * 3.6).toFixed(1) : '0.0'} <span className="text-[10px] text-neutral-500 font-normal">km/h</span>
                  </div>
                </div>
                <div className="bg-neutral-900 border border-white/5 rounded-2xl p-3">
                  <div className="text-neutral-500 text-[10px] uppercase font-bold mb-1">Distância</div>
                  <div className="text-lg font-bold">
                    {(totalDistance.current / 1000).toFixed(2)} <span className="text-[10px] text-neutral-500 font-normal">km</span>
                  </div>
                </div>
                <div className="bg-neutral-900 border border-white/5 rounded-2xl p-3">
                  <div className="text-neutral-500 text-[10px] uppercase font-bold mb-1">GPS</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <div className={`w-1.5 h-1.5 rounded-full ${currentSpeed !== null ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                    <span className="text-[10px] font-bold truncate">{currentSpeed !== null ? 'Sinal OK' : 'Buscando'}</span>
                  </div>
                </div>
              </div>
            </motion.section>
          ) : stats ? (
            <motion.section 
              key="summary"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-6"
            >
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-3xl p-8 text-center space-y-6">
                <div className="space-y-1">
                  <div className="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Activity className="w-6 h-6 text-black" />
                  </div>
                  <h2 className="text-2xl font-black uppercase tracking-tight">Resumo do Treino</h2>
                  <p className="text-neutral-500 text-sm">Bom trabalho! Aqui estão seus resultados.</p>
                </div>

                <div className="grid grid-cols-3 gap-4 py-4">
                  <div className="space-y-1">
                    <div className="text-[10px] text-neutral-500 font-bold uppercase">Distância</div>
                    <div className="text-xl font-black text-emerald-500">{stats.distance}km</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] text-neutral-500 font-bold uppercase">Duração</div>
                    <div className="text-xl font-black text-emerald-500">
                      {Math.floor(stats.duration / 60)}m{stats.duration % 60}s
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] text-neutral-500 font-bold uppercase">Pace Médio</div>
                    <div className="text-xl font-black text-emerald-500">{stats.avgPace}</div>
                  </div>
                </div>

                <button 
                  onClick={() => setStats(null)}
                  className="text-xs font-bold text-emerald-500/60 hover:text-emerald-500 transition-colors uppercase tracking-widest"
                >
                  Fechar Resumo
                </button>
              </div>
            </motion.section>
          ) : (
            <motion.section 
              key="idle"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="bg-neutral-900/30 border border-white/5 rounded-3xl p-6 space-y-4">
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center shrink-0">
                    <Info className="w-5 h-5 text-emerald-500" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="font-bold">Como funciona?</h3>
                    <p className="text-sm text-neutral-400 leading-relaxed">
                      O app vibrará continuamente se você estiver abaixo do ritmo definido. 
                      O silêncio significa que você está na meta!
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center shrink-0">
                    <MapPin className="w-5 h-5 text-blue-500" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="font-bold">Dica de Precisão</h3>
                    <p className="text-sm text-neutral-400 leading-relaxed">
                      Para melhores resultados, use o celular em um braçadeira ou bolso firme. 
                      O GPS funciona melhor em áreas abertas.
                    </p>
                  </div>
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* Error Message */}
        {error && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-red-500/20 border border-red-500/50 rounded-2xl p-4 flex gap-3 text-red-200 text-sm"
          >
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <p>{error}</p>
          </motion.div>
        )}

        {/* Action Button */}
        <div className="fixed bottom-10 left-0 right-0 px-6 max-w-md mx-auto">
          <button
            onClick={isRunning || countdown !== null ? stopTracking : startTracking}
            className={`w-full py-6 rounded-full font-black text-xl tracking-widest flex items-center justify-center gap-3 transition-all active:scale-95 shadow-2xl ${
              isRunning || countdown !== null
                ? 'bg-neutral-800 text-white hover:bg-neutral-700' 
                : 'bg-emerald-500 text-black hover:bg-emerald-400 shadow-emerald-500/20'
            }`}
          >
            {isRunning || countdown !== null ? (
              <>
                <Square className="w-6 h-6 fill-current" />
                PARAR TREINO
              </>
            ) : (
              <>
                <Play className="w-6 h-6 fill-current" />
                INICIAR TREINO
              </>
            )}
          </button>
        </div>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="w-full max-w-sm bg-neutral-900 border border-white/10 rounded-3xl p-8 space-y-8"
            >
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-black uppercase tracking-tight">Configurações</h2>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <Square className="w-5 h-5 text-neutral-500" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-bold text-neutral-400 uppercase tracking-widest">Filtro de Velocidade</span>
                  <span className="text-emerald-500 font-black">{(smoothingFactor * 100).toFixed(0)}%</span>
                </div>
                <p className="text-[10px] text-neutral-500 leading-relaxed">
                  Ajuste a suavidade da velocidade. 
                  <br />
                  <span className="text-emerald-500/50">Mais Rápido (100%)</span>: Reage instantaneamente, mas oscila mais.
                  <br />
                  <span className="text-blue-500/50">Mais Suave (1%)</span>: Muito estável, mas demora a reagir.
                </p>
                <input 
                  type="range" 
                  min="0.05" 
                  max="1" 
                  step="0.05" 
                  value={smoothingFactor}
                  onChange={(e) => setSmoothingFactor(parseFloat(e.target.value))}
                  className="w-full accent-emerald-500"
                />
              </div>

              <button 
                onClick={() => setShowSettings(false)}
                className="w-full py-4 bg-emerald-500 text-black rounded-2xl font-black uppercase tracking-widest hover:bg-emerald-400 transition-colors"
              >
                Salvar e Fechar
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Background Decoration */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10">
        <div className="absolute top-1/4 -left-20 w-80 h-80 bg-emerald-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 -right-20 w-80 h-80 bg-blue-500/10 rounded-full blur-[120px]" />
      </div>
    </div>
  );
}
