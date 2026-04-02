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
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVibrating, setIsVibrating] = useState(false);
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);
  
  // Refs for tracking
  const watchId = useRef<number | null>(null);
  const vibrationInterval = useRef<number | null>(null);

  // Target speed in m/s
  const targetSpeed = paceToSpeed(minInput, secInput);

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

  // Handle Vibration
  const startVibration = useCallback(() => {
    if (!isVibrating && 'vibrate' in navigator) {
      setIsVibrating(true);
      // Vibrate pattern: 500ms on, 500ms off
      const vibrate = () => {
        navigator.vibrate(500);
      };
      vibrate();
      vibrationInterval.current = window.setInterval(vibrate, 1000);
    }
  }, [isVibrating]);

  const stopVibration = useCallback(() => {
    if (isVibrating) {
      setIsVibrating(false);
      if (vibrationInterval.current) {
        clearInterval(vibrationInterval.current);
        vibrationInterval.current = null;
      }
      if ('vibrate' in navigator) {
        navigator.vibrate(0);
      }
    }
  }, [isVibrating]);

  const [isSimulating, setIsSimulating] = useState(false);
  const [simulatedSpeed, setSimulatedSpeed] = useState(0);

  // Start Tracking
  const startTracking = async () => {
    if (!navigator.geolocation && !isSimulating) {
      setError("Seu navegador não suporta GPS.");
      return;
    }

    setError(null);
    setIsRunning(true);
    requestWakeLock();

    if (isSimulating) {
      // Simulation logic
      const interval = window.setInterval(() => {
        // Simulated speed is handled by the slider in UI
      }, 1000);
      watchId.current = interval as unknown as number;
    } else {
      watchId.current = navigator.geolocation.watchPosition(
        (position) => {
          const speed = position.coords.speed; // speed in m/s
          setCurrentSpeed(speed);

          if (speed !== null) {
            if (speed < targetSpeed) {
              startVibration();
            } else {
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
    }
  };

  // Stop Tracking
  const stopTracking = useCallback(() => {
    setIsRunning(false);
    setCurrentSpeed(null);
    stopVibration();
    releaseWakeLock();
    if (watchId.current !== null) {
      if (isSimulating) {
        clearInterval(watchId.current);
      } else {
        navigator.geolocation.clearWatch(watchId.current);
      }
      watchId.current = null;
    }
  }, [stopVibration, releaseWakeLock, isSimulating]);

  // Effect for simulation speed updates
  useEffect(() => {
    if (isRunning && isSimulating) {
      setCurrentSpeed(simulatedSpeed);
      if (simulatedSpeed < targetSpeed) {
        startVibration();
      } else {
        stopVibration();
      }
    }
  }, [simulatedSpeed, isRunning, isSimulating, targetSpeed, startVibration, stopVibration]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
      }
      if (vibrationInterval.current) {
        clearInterval(vibrationInterval.current);
      }
      releaseWakeLock();
    };
  }, [releaseWakeLock]);

  return (
    <div className="min-h-screen bg-neutral-950 text-white font-sans selection:bg-emerald-500/30">
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
            onClick={() => setIsSimulating(!isSimulating)}
            className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter transition-colors ${
              isSimulating ? 'bg-blue-500 text-white' : 'bg-neutral-800 text-neutral-500'
            }`}
          >
            {isSimulating ? 'Simulação ON' : 'Simulação OFF'}
          </button>
          <button className="p-2 hover:bg-white/5 rounded-full transition-colors">
            <Settings className="w-5 h-5 text-neutral-400" />
          </button>
        </div>
      </header>

      <main className="max-w-md mx-auto p-6 space-y-8">
        {/* Pace Input Section */}
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
                disabled={isRunning}
                className="w-24 text-6xl font-black text-center bg-transparent border-b-2 border-emerald-500/30 focus:border-emerald-500 outline-none transition-colors disabled:opacity-50"
              />
              <span className="text-4xl font-bold text-neutral-600">:</span>
              <input 
                type="number" 
                value={secInput}
                onChange={(e) => setSecInput(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                disabled={isRunning}
                className="w-24 text-6xl font-black text-center bg-transparent border-b-2 border-emerald-500/30 focus:border-emerald-500 outline-none transition-colors disabled:opacity-50"
              />
            </div>
            <p className="text-neutral-500 text-sm">
              Equivale a {(targetSpeed * 3.6).toFixed(1)} km/h
            </p>
          </div>
        </section>

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
                isVibrating 
                  ? 'bg-red-500/10 border-red-500 shadow-[0_0_40px_-10px_rgba(239,68,68,0.3)]' 
                  : 'bg-emerald-500/10 border-emerald-500 shadow-[0_0_40px_-10px_rgba(16,185,129,0.3)]'
              }`}>
                <div className="flex flex-col items-center text-center gap-2">
                  <span className="text-sm font-bold uppercase tracking-widest opacity-60">
                    {isVibrating ? 'Abaixo da Meta' : 'No Ritmo'}
                  </span>
                  
                  <div className="text-7xl font-black tabular-nums">
                    {currentSpeed !== null 
                      ? formatPace(speedToPace(currentSpeed).min, speedToPace(currentSpeed).sec)
                      : '--:--'}
                  </div>
                  
                  <span className="text-neutral-400 font-medium">Ritmo Atual</span>
                </div>

                {isVibrating && (
                  <motion.div 
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ repeat: Infinity, duration: 0.5 }}
                    className="mt-6 flex items-center justify-center gap-2 text-red-500 font-bold"
                  >
                    <Vibrate className="w-5 h-5" />
                    <span>ACELERE!</span>
                  </motion.div>
                )}

                {isSimulating && (
                  <div className="mt-8 space-y-2">
                    <div className="flex justify-between text-[10px] text-neutral-500 font-bold uppercase">
                      <span>Simular Velocidade</span>
                      <span>{(simulatedSpeed * 3.6).toFixed(1)} km/h</span>
                    </div>
                    <input 
                      type="range" 
                      min="0" 
                      max="6" 
                      step="0.1" 
                      value={simulatedSpeed}
                      onChange={(e) => setSimulatedSpeed(parseFloat(e.target.value))}
                      className="w-full accent-blue-500"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-neutral-900 border border-white/5 rounded-2xl p-4">
                  <div className="text-neutral-500 text-xs uppercase font-bold mb-1">Velocidade</div>
                  <div className="text-xl font-bold">
                    {currentSpeed !== null ? (currentSpeed * 3.6).toFixed(1) : '0.0'} <span className="text-xs text-neutral-500">km/h</span>
                  </div>
                </div>
                <div className="bg-neutral-900 border border-white/5 rounded-2xl p-4">
                  <div className="text-neutral-500 text-xs uppercase font-bold mb-1">GPS</div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${currentSpeed !== null ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                    <span className="text-sm font-bold">{currentSpeed !== null ? 'Sinal Forte' : 'Buscando...'}</span>
                  </div>
                </div>
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
            onClick={isRunning ? stopTracking : startTracking}
            className={`w-full py-6 rounded-full font-black text-xl tracking-widest flex items-center justify-center gap-3 transition-all active:scale-95 shadow-2xl ${
              isRunning 
                ? 'bg-neutral-800 text-white hover:bg-neutral-700' 
                : 'bg-emerald-500 text-black hover:bg-emerald-400 shadow-emerald-500/20'
            }`}
          >
            {isRunning ? (
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

      {/* Background Decoration */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10">
        <div className="absolute top-1/4 -left-20 w-80 h-80 bg-emerald-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 -right-20 w-80 h-80 bg-blue-500/10 rounded-full blur-[120px]" />
      </div>
    </div>
  );
}
