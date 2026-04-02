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
  const [isGracePeriod, setIsGracePeriod] = useState(false);
  const [useSound, setUseSound] = useState(true);
  const [useVibration, setUseVibration] = useState(true);
  const [vibrationAuthorized, setVibrationAuthorized] = useState(false);
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
  const [useDynamicPace, setUseDynamicPace] = useState(false);
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);
  const [permissions, setPermissions] = useState<{
    location: PermissionState | 'unknown';
    notifications: NotificationPermission | 'unknown';
  }>({
    location: 'unknown',
    notifications: 'unknown'
  });
  const [gpsAvailable, setGpsAvailable] = useState(false);
  const [isCheckingGps, setIsCheckingGps] = useState(false);
  const [isVerifyingGps, setIsVerifyingGps] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isCompensating, setIsCompensating] = useState(false);
  const [adjustedTargetPace, setAdjustedTargetPace] = useState<{min: number, sec: number} | null>(null);
  const [duration, setDuration] = useState(0);
  
  const lastUpdateTimestamp = useRef<number>(Date.now());

  // Refs for tracking and state sync in callbacks
  const isRunningRef = useRef(false);
  const isGracePeriodRef = useRef(false);
  const isVibratingRef = useRef(false);
  const targetSpeedRef = useRef(0);
  const watchId = useRef<number | null>(null);
  const vibrationInterval = useRef<number | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const timerInterval = useRef<number | null>(null);
  const countdownInterval = useRef<number | null>(null);
  
  // Stats tracking refs
  const startTime = useRef<number | null>(null);
  const totalDistance = useRef<number>(0);
  const lastPosition = useRef<GeolocationCoordinates | null>(null);
  const smoothedSpeed = useRef<number | null>(null);
  const speedHistory = useRef<number[]>([]);
  const useDynamicPaceRef = useRef(false);

  const useSoundRef = useRef(useSound);
  const useVibrationRef = useRef(useVibration);

  useEffect(() => { useSoundRef.current = useSound; }, [useSound]);
  useEffect(() => { useVibrationRef.current = useVibration; }, [useVibration]);

  // Simple Exponential Moving Average for speed smoothing
  const updateSmoothedSpeed = (newSpeed: number | null, position?: GeolocationPosition) => {
    let speedToUse = newSpeed;

    // Fallback: Calculate speed from distance if raw speed is null or unreliable
    if ((speedToUse === null || speedToUse === 0) && position && lastPosition.current) {
      const lastPos = lastPosition.current as any;
      const timeDelta = (position.timestamp - lastPos.timestamp) / 1000;
      
      // Only use fallback if we have a reasonable time gap (0.5s to 5s)
      if (timeDelta > 0.5 && timeDelta < 5) {
        const dist = calculateDistance(
          lastPosition.current.latitude,
          lastPosition.current.longitude,
          position.coords.latitude,
          position.coords.longitude
        );
        
        // Filter out GPS jumps (e.g. > 30m in 1s is likely error)
        // Also ignore very small movements to avoid drift
        if (dist > 0.5 && dist < 30) {
          speedToUse = dist / timeDelta;
          console.log("Calculated speed fallback:", speedToUse.toFixed(2), "m/s (dist:", dist.toFixed(2), "m, time:", timeDelta.toFixed(2), "s)");
        }
      }
    }

    if (speedToUse === null) return smoothedSpeed.current;
    
    if (smoothedSpeed.current === null) {
      smoothedSpeed.current = speedToUse;
    } else {
      smoothedSpeed.current = (smoothingFactor * speedToUse) + ((1 - smoothingFactor) * smoothedSpeed.current);
    }
    return smoothedSpeed.current;
  };

  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

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
    console.log("Is Running state changed:", isRunning);
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    console.log("Grace period active:", isGracePeriod);
    isGracePeriodRef.current = isGracePeriod;
  }, [isGracePeriod]);

  useEffect(() => {
    console.log("Vibration active:", isVibrating);
    isVibratingRef.current = isVibrating;
  }, [isVibrating]);

  useEffect(() => {
    console.log("Dynamic Pace enabled:", useDynamicPace);
    useDynamicPaceRef.current = useDynamicPace;
  }, [useDynamicPace]);

  // Target speed in m/s
  const targetSpeed = paceToSpeed(minInput, secInput);
  useEffect(() => {
    console.log("Target speed updated to:", targetSpeed.toFixed(2), "m/s");
    targetSpeedRef.current = targetSpeed;
  }, [targetSpeed]);

  // Manual GPS Check
  const checkGpsManually = async () => {
    if (isCheckingGps) return;
    setIsCheckingGps(true);
    setError(null);
    
    try {
      // 1. Clear all active watches to avoid conflicts
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }

      // 2. Try High Accuracy first
      try {
        await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (p) => resolve(p),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        });
      } catch (highAccErr: any) {
        // 3. Fallback to Low Accuracy if High fails (except for permission denied)
        if (highAccErr.code !== 1) {
          console.warn("High accuracy failed, trying low accuracy...");
          await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
              (p) => resolve(p),
              (err) => reject(err),
              { enableHighAccuracy: false, timeout: 10000, maximumAge: 5000 }
            );
          });
        } else {
          throw highAccErr;
        }
      }

      setGpsAvailable(true);

      // 4. Restart the watch
      startWatchPosition();
    } catch (err: any) {
      console.error("Manual GPS check failed:", err);
      let msg = "Não foi possível encontrar o sinal de GPS.";
      if (err.code === 1) msg = "Permissão de GPS negada. Verifique as configurações do navegador.";
      if (err.code === 2) msg = "Sinal de GPS indisponível. Verifique se o GPS do aparelho está ligado.";
      if (err.code === 3) msg = "Tempo esgotado. Tente ir para um local aberto.";
      setError(msg);
      setGpsAvailable(false);
    } finally {
      setIsCheckingGps(false);
    }
  };

  const startWatchPosition = async () => {
    if (watchId.current !== null) return;

    console.log("Starting GPS Watch Position...");
    lastUpdateTimestamp.current = Date.now();

    // Kickstart sensor to ensure it's active
    try {
      await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { 
          enableHighAccuracy: true, 
          timeout: 5000, 
          maximumAge: 0 
        });
      });
      console.log("GPS Kickstart success");
      setGpsAvailable(true);
    } catch (e) {
      console.warn("GPS Kickstart failed, proceeding to watchPosition anyway", e);
    }

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        lastUpdateTimestamp.current = Date.now();
        setGpsAvailable(true);
        
        const rawSpeed = position.coords.speed; // speed in m/s
        const speed = updateSmoothedSpeed(rawSpeed, position);
        setCurrentSpeed(speed);

        // Guard: check if we are still supposed to be running
        if (!isRunningRef.current) {
          // Even if not running, we keep track of last position for smooth start
          lastPosition.current = position.coords;
          (position.coords as any).timestamp = position.timestamp;
          return;
        }

        // Update distance
        if (lastPosition.current) {
          const dist = calculateDistance(
            lastPosition.current.latitude,
            lastPosition.current.longitude,
            position.coords.latitude,
            position.coords.longitude
          );
          
          // Filter out GPS jumps (e.g. > 30m in 1s is likely error)
          // Also ignore very small movements to avoid drift
          if (dist < 30 && dist > 0.5) {
            totalDistance.current += dist;
          }
        }
        
        // Store position with timestamp for speed calculation fallback
        (position.coords as any).timestamp = position.timestamp;
        lastPosition.current = position.coords;

        if (speed !== null && !isGracePeriodRef.current) {
          let effectiveTargetSpeed = targetSpeedRef.current;
          let compensating = false;

          // Dynamic Pace Logic
          if (useDynamicPaceRef.current && startTime.current) {
            const elapsedSec = (Date.now() - startTime.current) / 1000;
            if (elapsedSec > 15) { // Wait for more data for stability
              const avgSpeedSoFar = totalDistance.current / elapsedSec;
              if (avgSpeedSoFar > 0.2 && avgSpeedSoFar < targetSpeedRef.current) {
                // If average is below target, we need to run faster to compensate
                const adjustment = targetSpeedRef.current - avgSpeedSoFar;
                effectiveTargetSpeed = targetSpeedRef.current + adjustment;
                // Cap the adjustment to 25% faster to avoid impossible targets
                effectiveTargetSpeed = Math.min(effectiveTargetSpeed, targetSpeedRef.current * 1.25);
                compensating = true;
                setAdjustedTargetPace(speedToPace(effectiveTargetSpeed));
              } else {
                setAdjustedTargetPace(null);
              }
            }
          } else {
            setAdjustedTargetPace(null);
          }
          
          setIsCompensating(compensating);

          // Hysteresis to avoid rapid vibration switching
          const threshold = 0.05; // 0.05 m/s (~0.18 km/h)
          
          console.log(`Comparação: Atual ${speed.toFixed(2)} m/s vs Meta ${effectiveTargetSpeed.toFixed(2)} m/s`);

          if (speed < effectiveTargetSpeed - threshold) {
            // Notify if below target
            if (Notification.permission === 'granted' && !isVibratingRef.current) {
              try {
                new Notification("DengosPace", {
                  body: compensating ? "Compense o ritmo! Acelere!" : "Você está abaixo do ritmo! Acelere!",
                  silent: true,
                  tag: 'pace-alert',
                  renotify: true
                } as any);
              } catch (e) {
                console.error("Erro na notificação de alerta:", e);
              }
            }
            startVibration();
          } else if (speed > effectiveTargetSpeed + threshold) {
            if (isVibratingRef.current && Notification.permission === 'granted') {
              try {
                new Notification("DengosPace", {
                  body: "Ritmo recuperado!",
                  silent: true,
                  tag: 'pace-alert',
                  renotify: true
                } as any);
              } catch (e) {
                console.error("Erro na notificação de recuperação:", e);
              }
            }
            stopVibration();
          }
        }
      },
      (err) => {
        console.error("Erro no watchPosition:", err);
        setGpsAvailable(false);
        let msg = "Erro ao acessar GPS.";
        if (err.code === 1) msg = "Permissão de GPS negada pelo sistema.";
        if (err.code === 2) msg = "Sinal de GPS indisponível no momento.";
        if (err.code === 3) msg = "Tempo esgotado ao buscar sinal de GPS.";
        setError(msg);
        // Don't stop immediately on timeout during activity, try to recover
        if (err.code === 1 && isRunningRef.current) stopTracking();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000
      }
    );
  };

  // Check permissions and start GPS watch
  useEffect(() => {
    const initGps = async () => {
      if (watchId.current !== null) return;
      await startWatchPosition();
    };

    if ('permissions' in navigator) {
      navigator.permissions.query({ name: 'geolocation' as PermissionName }).then(status => {
        setPermissions(prev => ({ ...prev, location: status.state }));
        if (status.state === 'granted') initGps();
        status.onchange = () => {
          setPermissions(prev => ({ ...prev, location: status.state }));
          if (status.state === 'granted') initGps();
        };
      });
    } else {
      initGps();
    }
    
    if ('Notification' in window) {
      setPermissions(prev => ({ ...prev, notifications: Notification.permission }));
    }

    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    };
  }, []);

  // GPS Watchdog: Restart watch if no updates for 15s during activity
  useEffect(() => {
    if (!isRunning) return;
    
    const watchdogInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastUpdateTimestamp.current > 15000) {
        console.warn("GPS Watchdog: No updates for 15s. Restarting GPS...");
        if (watchId.current !== null) {
          navigator.geolocation.clearWatch(watchId.current);
          watchId.current = null;
        }
        startWatchPosition();
      }
    }, 5000);
    
    return () => clearInterval(watchdogInterval);
  }, [isRunning]);

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
      if (err.name === 'NotAllowedError') {
        console.warn("Wake Lock: Acesso negado pela política de permissões. A tela pode apagar durante o treino.");
      } else {
        console.error(`${err.name}, ${err.message}`);
      }
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
    console.log("Tocando Beep de Alerta");
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
      console.log("Iniciando Alerta de Ritmo (Vibração + Som)");
      setIsVibrating(true);
      isVibratingRef.current = true;
      
      // Vibrate pattern: 400ms on, 200ms off, 400ms on
      // We use a recursive timeout for better background reliability than setInterval
      const vibrateLoop = () => {
        if (!isVibratingRef.current) return;
        
        if (useVibrationRef.current && 'vibrate' in navigator) {
          navigator.vibrate([400, 200, 400]);
        }
        if (useSoundRef.current) {
          playBeep();
        }
        
        vibrationInterval.current = window.setTimeout(vibrateLoop, 1500);
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

  const activateVibration = () => {
    // Trigger a small vibration to "unlock" the API and confirm permission
    if ('vibrate' in navigator) {
      navigator.vibrate(100);
      setVibrationAuthorized(true);
    }
  };

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

    // Unlock vibration API with a user gesture
    activateVibration();

    setError(null);
    setStats(null);
    setCountdown(5);

    if (countdownInterval.current) clearInterval(countdownInterval.current);
    countdownInterval.current = window.setInterval(() => {
      setCountdown(prev => {
        if (prev === null || prev <= 1) {
          if (countdownInterval.current) clearInterval(countdownInterval.current);
          countdownInterval.current = null;
          verifyAndStart();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const verifyAndStart = async () => {
    // If GPS is already available, start immediately
    if (gpsAvailable) {
      initTracking();
      return;
    }

    // Otherwise, try 3 times
    setIsVerifyingGps(true);
    setRetryCount(1);
    
    for (let i = 1; i <= 3; i++) {
      setRetryCount(i);
      try {
        await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { 
            enableHighAccuracy: true, 
            timeout: 10000, 
            maximumAge: 0 
          });
        });
        // Success!
        setGpsAvailable(true);
        setIsVerifyingGps(false);
        initTracking();
        return;
      } catch (err) {
        console.warn(`GPS verification attempt ${i} failed`, err);
        if (i === 3) {
          setError("Erro de GPS: Não foi possível obter um sinal estável após 3 tentativas.");
          setIsVerifyingGps(false);
        }
      }
    }
  };

  const initTracking = () => {
    setIsRunning(true);
    isRunningRef.current = true;
    
    // Reset stats
    totalDistance.current = 0;
    setDuration(0);
    startTime.current = Date.now();
    
    // Target speed from input
    targetSpeedRef.current = paceToSpeed(minInput, secInput);
    useDynamicPaceRef.current = useDynamicPace;

    // Grace period (10s)
    setIsGracePeriod(true);
    isGracePeriodRef.current = true;
    setTimeout(() => {
      setIsGracePeriod(false);
      isGracePeriodRef.current = false;
    }, 10000);

    // Timer
    if (timerInterval.current) clearInterval(timerInterval.current);
    timerInterval.current = window.setInterval(() => {
      setDuration(prev => prev + 1);
    }, 1000);

    requestWakeLock();

    // Send start notification
    try {
      if (Notification.permission === 'granted') {
        new Notification("DengosPace", {
          body: "Monitoramento iniciado. Mantenha o ritmo!",
          icon: "/favicon.ico",
          silent: true
        });
      }
    } catch (nErr) {
      console.error("Erro ao enviar notificação de início:", nErr);
    }
  };

  // Stop Tracking
  const stopTracking = useCallback(() => {
    console.log("Stopping Tracking...");
    
    setCountdown(null);
    setIsVerifyingGps(false);
    if (countdownInterval.current) {
      clearInterval(countdownInterval.current);
      countdownInterval.current = null;
    }

    if (timerInterval.current) {
      clearInterval(timerInterval.current);
      timerInterval.current = null;
    }

    const finalDuration = duration;
    const finalDistance = totalDistance.current / 1000; // km
    const avgSpeed = finalDuration > 0 ? (totalDistance.current / finalDuration) : 0;
    const avgPace = avgSpeed > 0 ? speedToPace(avgSpeed) : { min: 0, sec: 0 };

    setStats({
      distance: Number(finalDistance.toFixed(2)),
      duration: finalDuration,
      avgPace: formatPace(avgPace.min, avgPace.sec)
    });

    setIsRunning(false);
    isRunningRef.current = false;
    setIsGracePeriod(false);
    isGracePeriodRef.current = false;
    setIsCompensating(false);
    setAdjustedTargetPace(null);
    stopVibration();
    releaseWakeLock();

    // Send stop notification
    if (Notification.permission === 'granted') {
      new Notification("DengosPace", {
        body: `Treino finalizado. ${finalDistance.toFixed(2)}km em ${formatPace(avgPace.min, avgPace.sec)} min/km.`,
        silent: true,
        tag: 'pace-alert'
      });
    }
  }, [duration, stopVibration, releaseWakeLock]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
      }
      if (countdownInterval.current) {
        clearInterval(countdownInterval.current);
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
          {permissions.notifications === 'granted' ? (
            <div className="w-2 h-2 rounded-full bg-emerald-500" title="Notificações Ativas" />
          ) : (
            <div className="w-2 h-2 rounded-full bg-neutral-700" title="Notificações Desativadas" />
          )}
          <button 
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-white/5 rounded-full transition-colors relative"
          >
            <Settings className="w-5 h-5 text-neutral-400" />
          </button>
        </div>
      </header>

      <main className="max-w-md mx-auto p-6 space-y-6 pb-40">
        {/* Permission Warnings */}
        {permissions.location === 'denied' && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-2xl p-4 flex gap-3 text-red-200 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <p>O acesso ao GPS foi negado. Por favor, habilite nas configurações do navegador para usar o app.</p>
          </div>
        )}

        {/* GPS Status & Info */}
        <div className="flex justify-between items-center px-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${gpsAvailable ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">
                {gpsAvailable ? 'GPS Conectado' : 'Buscando GPS...'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500/50' : 'bg-blue-500 animate-pulse'}`} />
              <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">
                {isOnline ? 'Online' : 'Modo Offline Ativo'}
              </span>
            </div>
          </div>
          {isRunning && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
              <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Treino em Curso</span>
            </div>
          )}
        </div>

        {/* Main Dashboard Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-neutral-900/50 border border-white/5 rounded-3xl p-6 space-y-1">
            <div className="text-neutral-500 text-[10px] uppercase font-bold tracking-widest">Distância</div>
            <div className="text-3xl font-black text-white">
              {(totalDistance.current / 1000).toFixed(2)} <span className="text-sm text-neutral-500 font-bold uppercase">km</span>
            </div>
          </div>
          <div className="bg-neutral-900/50 border border-white/5 rounded-3xl p-6 space-y-1">
            <div className="text-neutral-500 text-[10px] uppercase font-bold tracking-widest">Duração</div>
            <div className="text-3xl font-black text-white">
              {Math.floor(duration / 60)}:{(duration % 60).toString().padStart(2, '0')}
            </div>
          </div>
        </div>

        {/* Pace Section */}
        <div className={`border rounded-[40px] p-8 space-y-8 relative overflow-hidden transition-all duration-500 ${
          isRunning && isVibrating ? 'bg-red-500/20 border-red-500/50' : 'bg-neutral-900 border-white/10'
        }`}>
          {/* Background Highlight for Pace status */}
          {isRunning && currentSpeed !== null && (
            <div className={`absolute inset-0 opacity-10 transition-colors duration-500 ${
              isVibrating ? 'bg-red-500' : 'bg-emerald-500'
            }`} />
          )}

          <div className="relative z-10 space-y-6">
            {isRunning && !isGracePeriod && (
              <div className="text-center">
                <span className={`text-[10px] font-black uppercase tracking-[0.2em] px-3 py-1 rounded-full ${
                  isVibrating ? 'bg-red-500 text-white animate-pulse' : 'bg-emerald-500/20 text-emerald-500'
                }`}>
                  {isVibrating ? 'Acelere! Abaixo do Ritmo' : 'Ritmo OK'}
                </span>
              </div>
            )}
            
            <div className="grid grid-cols-2 gap-4 divide-x divide-white/5">
              <div className="text-center space-y-1">
                <div className="text-neutral-500 text-[10px] uppercase font-bold tracking-widest">Velocidade</div>
                <div className="text-4xl font-black tracking-tighter tabular-nums">
                  {currentSpeed !== null ? (currentSpeed * 3.6).toFixed(1) : '0.0'}
                </div>
                <div className="text-[10px] text-neutral-500 font-bold uppercase tracking-widest">km/h</div>
              </div>
              
              <div className="text-center space-y-1">
                <div className="text-neutral-500 text-[10px] uppercase font-bold tracking-widest">Ritmo Atual</div>
                <div className="text-4xl font-black tracking-tighter tabular-nums">
                  {currentSpeed && currentSpeed > 0.2 ? (
                    formatPace(speedToPace(currentSpeed).min, speedToPace(currentSpeed).sec)
                  ) : (
                    '--:--'
                  )}
                </div>
                <div className="text-[10px] text-neutral-500 font-bold uppercase tracking-widest">min/km</div>
              </div>
            </div>

            {/* Target Pace Input / Display */}
            <div className="pt-6 border-t border-white/5 space-y-4">
              <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-widest text-neutral-500">
                <span>Meta Definida</span>
                {isRunning && isCompensating && (
                  <span className="text-blue-500 animate-pulse">Compensando Atraso</span>
                )}
              </div>
              
              <div className="flex items-center justify-center gap-4">
                {isRunning ? (
                  <div className="flex flex-col items-center">
                    <div className="text-4xl font-black text-emerald-500 tabular-nums">
                      {adjustedTargetPace ? (
                        formatPace(adjustedTargetPace.min, adjustedTargetPace.sec)
                      ) : (
                        formatPace(minInput, secInput)
                      )}
                    </div>
                    <div className="text-[10px] font-bold text-neutral-600 uppercase tracking-widest mt-1">
                      Meta: {(targetSpeedRef.current * 3.6).toFixed(1)} km/h
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input 
                      type="number" 
                      value={minInput}
                      onChange={(e) => setMinInput(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-16 text-4xl font-black text-center bg-transparent border-b-2 border-emerald-500/30 focus:border-emerald-500 outline-none transition-colors"
                    />
                    <span className="text-2xl font-black text-neutral-700">:</span>
                    <input 
                      type="number" 
                      value={secInput}
                      onChange={(e) => setSecInput(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                      className="w-16 text-4xl font-black text-center bg-transparent border-b-2 border-emerald-500/30 focus:border-emerald-500 outline-none transition-colors"
                    />
                  </div>
                )}
              </div>

              {!isRunning && (
                <div className="text-center">
                  <span className="text-[10px] font-bold text-neutral-600 uppercase tracking-widest">
                    Equivalente a: {((1 / ((minInput * 60 + secInput) / 3600)) || 0).toFixed(1)} km/h
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Grace Period Indicator */}
        {isRunning && isGracePeriod && (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-4 flex items-center gap-3">
            <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0" />
            <div className="space-y-0.5">
              <div className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Período de Aceleração</div>
              <p className="text-[10px] text-blue-400/70">Aguardando estabilização do ritmo...</p>
            </div>
          </div>
        )}

        {/* Last Run Summary (Stats) */}
        {stats && !isRunning && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-emerald-500/10 border border-emerald-500/30 rounded-3xl p-6 space-y-4"
          >
            <div className="flex justify-between items-center">
              <h3 className="text-xs font-black uppercase tracking-widest text-emerald-500">Último Treino</h3>
              <button onClick={() => setStats(null)} className="p-1 hover:bg-white/5 rounded-full">
                <Square className="w-3 h-3 text-neutral-500" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-[10px] text-neutral-500 font-bold uppercase mb-1">Dist.</div>
                <div className="text-sm font-black">{stats.distance}km</div>
              </div>
              <div>
                <div className="text-[10px] text-neutral-500 font-bold uppercase mb-1">Tempo</div>
                <div className="text-sm font-black">{Math.floor(stats.duration / 60)}m{stats.duration % 60}s</div>
              </div>
              <div>
                <div className="text-[10px] text-neutral-500 font-bold uppercase mb-1">Pace</div>
                <div className="text-sm font-black">{stats.avgPace}</div>
              </div>
            </div>
          </motion.div>
        )}

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
            onClick={isRunning || countdown !== null || isVerifyingGps ? stopTracking : startTracking}
            className={`w-full py-6 rounded-full font-black text-xl tracking-widest flex items-center justify-center gap-3 transition-all active:scale-95 shadow-2xl ${
              isRunning || countdown !== null || isVerifyingGps
                ? 'bg-neutral-800 text-white hover:bg-neutral-700' 
                : 'bg-emerald-500 text-black hover:bg-emerald-400 shadow-emerald-500/20'
            }`}
          >
            {isVerifyingGps ? (
              <>
                <div className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                CONECTANDO...
              </>
            ) : countdown !== null ? (
              <>
                <span className="text-3xl animate-ping">{countdown}</span>
                PREPARE-SE
              </>
            ) : isRunning ? (
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

              <div className="space-y-6">
                {/* Alert Options */}
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => setUseVibration(!useVibration)}
                    className={`p-4 rounded-2xl border transition-all flex flex-col items-center gap-2 ${
                      useVibration ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-500' : 'bg-neutral-800/50 border-white/5 text-neutral-500'
                    }`}
                  >
                    <Vibrate className="w-5 h-5" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Vibração</span>
                  </button>
                  <button 
                    onClick={() => setUseSound(!useSound)}
                    className={`p-4 rounded-2xl border transition-all flex flex-col items-center gap-2 ${
                      useSound ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-500' : 'bg-neutral-800/50 border-white/5 text-neutral-500'
                    }`}
                  >
                    <Activity className="w-5 h-5" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Som</span>
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

                <div className="space-y-4 pt-4 border-t border-white/5">
                  <div className="flex justify-between items-center">
                    <div className="space-y-1">
                      <span className="text-sm font-bold text-neutral-400 uppercase tracking-widest block">Ritmo Dinâmico</span>
                      <p className="text-[10px] text-neutral-500 leading-relaxed max-w-[200px]">
                        Ajusta sua meta em tempo real para compensar atrasos e atingir o pace médio final.
                      </p>
                    </div>
                    <button 
                      onClick={() => setUseDynamicPace(!useDynamicPace)}
                      className={`w-12 h-6 rounded-full transition-colors relative ${useDynamicPace ? 'bg-emerald-500' : 'bg-neutral-800'}`}
                    >
                      <motion.div 
                        animate={{ x: useDynamicPace ? 24 : 4 }}
                        className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm"
                      />
                    </button>
                  </div>
                </div>

                <div className="pt-4 text-center">
                  <span className="text-[8px] font-bold text-neutral-700 uppercase tracking-[0.3em]">
                    DengosPace v1.2.0
                  </span>
                </div>
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
