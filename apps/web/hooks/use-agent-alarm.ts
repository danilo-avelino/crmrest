"use client";

import { useEffect, useRef, useState } from "react";

const VOICE_EVERY_MS = 60_000;

/**
 * Chamado parado: a cada 10 minutos sem resposta da equipe o alarme volta, alternando o bipe inicial (rodadas ímpares)
 * e a notificação do sistema (rodadas pares, em `useCallNotifications`). 19/11/2026: 12 conversas passadas para a
 * equipe na varredura de 17–18/11 ficaram sem resposta depois do primeiro aviso.
 */
export const REMIND_EVERY_MS = 10 * 60_000;
const REMIND_CHECK_MS = 10_000;

/** Quantos intervalos de 10 minutos o chamado urgente mais antigo (`urgentSince`) já esperou. */
export const reminderRound = (since: string | null, now = Date.now()) => (since ? Math.floor((now - Date.parse(since)) / REMIND_EVERY_MS) : 0);

/** Fala gravada (voz Bianca, ElevenLabs) em `public/sons`: "Uma conversa aguardando resposta"... até nove; dali em diante, "Muitas". */
const voiceFile = (waiting: number) => `/sons/aguardando-${waiting > 9 ? "muitas" : waiting}.mp3`;

/**
 * Aviso de conversas esperando um atendente: um bipe quando chega uma nova e, enquanto houver alguma esperando,
 * uma voz a cada minuto dizendo quantas são. O navegador só libera o som depois de um clique na página; até lá,
 * `blocked` avisa a tela.
 */
export function useAgentAlarm(waiting: number, urgentSince: string | null = null): { blocked: boolean } {
  const [blocked, setBlocked] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const waitingRef = useRef(waiting);
  const urgentRef = useRef(urgentSince);
  const handledRound = useRef({ since: urgentSince, round: reminderRound(urgentSince) });
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
    // Lembrete do chamado parado: nas rodadas ímpares, o bipe inicial de novo (as pares são a notificação).
    const reminder = setInterval(() => {
      const seen = handledRound.current;
      const round = reminderRound(urgentRef.current);
      if (seen.since !== urgentRef.current) handledRound.current = { since: urgentRef.current, round }; // outro chamado passou a ser o mais antigo
      else if (round > seen.round) {
        handledRound.current = { since: seen.since, round };
        if (round % 2 === 1 && play(audio, () => setBlocked(true))) ringBeeps(audio);
      }
    }, REMIND_CHECK_MS);
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      clearInterval(timer);
      clearInterval(reminder);
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      setBlocked(false);
      pending.current = false;
      audioRef.current = null;
      void audio.close();
    };
  }, [ringing]);

  useEffect(() => {
    urgentRef.current = urgentSince;
  }, [urgentSince]);

  useEffect(() => {
    waitingRef.current = waiting;
    const audio = audioRef.current;
    if (audio && waiting > previous.current) {
      if (play(audio, () => setBlocked(true))) {
        setBlocked(false);
        ringBeeps(audio);
      } else pending.current = true;
    }
    previous.current = waiting;
  }, [waiting]);

  return { blocked };
}

/** Bipes a cada 0,3 s durante 5 s (17 toques; o último termina em 4,98 s). */
function ringBeeps(audio: AudioContext) {
  for (let delay = 0; delay < 5 - 0.18; delay += 0.3) tone(audio, 880, audio.currentTime + delay, 0.18, 0.3);
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
