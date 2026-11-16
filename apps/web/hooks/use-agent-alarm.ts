"use client";

import { useEffect, useRef, useState } from "react";

const VOICE_EVERY_MS = 60_000;

/** Fala gravada (voz Bianca, ElevenLabs) em `public/sons`: "Uma conversa aguardando resposta"... até nove; dali em diante, "Muitas". */
const voiceFile = (waiting: number) => `/sons/aguardando-${waiting > 9 ? "muitas" : waiting}.mp3`;

/**
 * Aviso de conversas esperando um atendente: um bipe quando chega uma nova e, enquanto houver alguma esperando,
 * uma voz a cada minuto dizendo quantas são. O navegador só libera o som depois de um clique na página; até lá,
 * `blocked` avisa a tela.
 */
export function useAgentAlarm(waiting: number): { blocked: boolean } {
  const [blocked, setBlocked] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const waitingRef = useRef(waiting);
  const previous = useRef(0);
  const pending = useRef(false);
  const ringing = waiting > 0;

  useEffect(() => {
    if (!ringing) return;
    let audio: AudioContext;
    try {
      audio = new AudioContext();
    } catch {
      return; // sem áudio disponível: a lista ainda destaca a conversa
    }
    audioRef.current = audio;
    const speak = () => {
      if (!play(audio, () => setBlocked(true))) {
        pending.current = true;
        return;
      }
      setBlocked(false);
      void say(audio, voiceFile(waitingRef.current));
    };
    // Liberado o som pelo clique, fala logo o aviso que ficou para trás.
    const unlock = () =>
      void audio.resume().then(() => {
        setBlocked(false);
        if (pending.current) {
          pending.current = false;
          speak();
        }
      });
    const timer = setInterval(speak, VOICE_EVERY_MS);
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      setBlocked(false);
      pending.current = false;
      audioRef.current = null;
      void audio.close();
    };
  }, [ringing]);

  useEffect(() => {
    waitingRef.current = waiting;
    const audio = audioRef.current;
    if (audio && waiting > previous.current) {
      if (play(audio, () => setBlocked(true))) {
        setBlocked(false);
        // Bipes a cada 0,3 s durante 5 s (17 toques; o último termina em 4,98 s).
        for (let delay = 0; delay < 5 - 0.18; delay += 0.3) tone(audio, 880, audio.currentTime + delay, 0.18, 0.3);
      } else pending.current = true;
    }
    previous.current = waiting;
  }, [waiting]);

  return { blocked };
}

/** O som está liberado? Se não, tenta liberar e avisa a tela. */
function play(audio: AudioContext, onBlocked: () => void): boolean {
  if (audio.state === "running") return true;
  void audio.resume();
  onBlocked();
  return false;
}

async function say(audio: AudioContext, src: string) {
  try {
    const data = await (await fetch(src)).arrayBuffer();
    const source = audio.createBufferSource();
    source.buffer = await audio.decodeAudioData(data);
    // Volume em dobro: as falas têm pico em −8,8 dB, então o ganho 2 (+6 dB) não distorce.
    const gain = audio.createGain();
    gain.gain.value = 2;
    source.connect(gain).connect(audio.destination);
    source.start();
  } catch {
    // Sem o arquivo ou com o contexto já fechado: o bipe e o destaque na lista continuam.
  }
}

function tone(audio: AudioContext, frequency: number, start: number, length: number, volume: number) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.setValueAtTime(volume, start + length - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + length);
}
