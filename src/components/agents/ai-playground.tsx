'use client';

import { useEffect, useRef, useState } from 'react';
import { useAction, useMutation, useConvex } from 'convex/react';
import { toast } from 'sonner';
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight, ImageIcon, X, Mic, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { uploadAccountMedia, deleteAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';

import { api } from '../../../convex/_generated/api';

/** A media attachment on a user turn. `previewUrl` is a LOCAL object URL
 *  (never the R2 URL), so the bubble keeps rendering after the transient R2
 *  object is deleted. `understanding` is what the bot heard/saw;
 *  `historyContent` is the exact `[voice note] …` / `[image] …` line the
 *  server built, replayed as plain text on later sends so nothing is
 *  transcribed twice. */
interface MediaAttachment {
  kind: 'audio' | 'image';
  previewUrl: string;
  understanding?: string;
  understoodFailed?: boolean;
  historyContent?: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
  /** user-only: an attached voice note or image. */
  media?: MediaAttachment;
}

/** The message shape the `playground` action accepts. */
type PlaygroundMessage = {
  role: 'user' | 'assistant';
  content: string;
  media?: { kind: 'audio' | 'image'; key: string };
};

/** Soft cap on a Playground voice note; auto-stops to bound Whisper cost. */
const MAX_RECORDING_SECONDS = 60;

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const playground = useAction(api.aiReply.playground);
  const startUpload = useMutation(api.files.startUpload);
  const convex = useConvex();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  /** Which kind of media the in-flight turn is understanding, if any — drives
   *  the "Transcribing…" / "Reading image…" sending indicator below. */
  const [pendingKind, setPendingKind] = useState<'audio' | 'image' | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Every object URL we create, revoked on reset/unmount. */
  const objectUrlsRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stagedImage, setStagedImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Synchronous in-flight guard: `recording` state only flips true after
   *  `getUserMedia` resolves, so a ref (not state) is needed to block a
   *  second concurrent `startRecording` call during that window. */
  const startingRecordingRef = useRef(false);
  /** Live-mount flag, read by `startRecording` after it resumes from the
   *  `getUserMedia` await — the unmount cleanup below can't see a recorder
   *  that doesn't exist yet, so the resuming continuation has to check
   *  whether there's still a UI to record into. */
  const isMountedRef = useRef(true);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  // Revoke all local preview URLs on unmount.
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      objectUrlsRef.current = [];
    };
  }, []);

  // Release the microphone if a recording is still in progress when this
  // component unmounts (e.g. the user navigates away mid-recording) —
  // discard, same contract as cancelRecording: never send after the UI is
  // gone. Inlined against the refs directly (rather than calling
  // cancelRecording) so this effect can sit near the component's other
  // mount/unmount effects without a forward reference to a function
  // defined further down.
  useEffect(() => {
    // Re-assert on mount, not just via the ref initialiser: under StrictMode
    // effects run mount → unmount → mount, and the second mount has to undo
    // the first cleanup's `false`.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.onstop = () => recorder.stream.getTracks().forEach((tr) => tr.stop());
        recorder.stop();
      }
    };
  }, []);

  /**
   * Run one user turn: optimistically append it, send the full transcript
   * (replaying prior media turns as plain text; passing the new turn's live
   * R2 key if any), then append the reply and store what the bot understood.
   */
  const runTurn = async (
    userTurn: Turn,
    liveMedia: { kind: 'audio' | 'image'; key: string } | null,
  ): Promise<boolean> => {
    const priorTurns = turns;
    const nextTurns: Turn[] = [...priorTurns, userTurn];
    setTurns(nextTurns);
    setSending(true);
    setPendingKind(liveMedia?.kind ?? null);
    try {
      const messages: PlaygroundMessage[] = nextTurns.map((t, i) => {
        const isNew = i === nextTurns.length - 1;
        if (isNew && liveMedia) {
          return { role: t.role, content: t.content, media: liveMedia };
        }
        if (t.media) {
          // Already-understood media turn → replay as plain text.
          return { role: t.role, content: t.media.historyContent ?? t.content };
        }
        return { role: t.role, content: t.content };
      });

      const data = await playground({ messages });
      if ('error' in data) {
        if (data.code === 'ai_not_configured') {
          toast.error('No agent configured yet — finish Setup first.');
        } else {
          toast.error(data.error ?? "Couldn't get a reply.");
        }
        setTurns(priorTurns);
        if (!userTurn.media) setInput(userTurn.content);
        return false;
      }

      const understood = data.understanding;
      const committed: Turn[] = nextTurns.map((t, i) => {
        if (i === nextTurns.length - 1 && liveMedia && t.media) {
          return {
            ...t,
            media: {
              ...t.media,
              understanding: understood?.transcription ?? undefined,
              understoodFailed: understood ? understood.transcription === null : true,
              historyContent: understood?.historyContent,
            },
          };
        }
        return t;
      });
      setTurns([
        ...committed,
        {
          role: 'assistant',
          content: data.reply.trim() ? data.reply : '',
          handoff: Boolean(data.handoff),
        },
      ]);
      return true;
    } catch {
      toast.error("Couldn't reach the agent.");
      setTurns(priorTurns);
      if (!userTurn.media) setInput(userTurn.content);
      return false;
    } finally {
      setSending(false);
      setPendingKind(null);
      // The R2 object was only needed for the server to understand it; its
      // text is now cached on the turn. Best-effort GC.
      // Best-effort GC — `deleteAccountMedia` does not catch internally, so
      // swallow here (its contract is fire-and-forget); a missed delete is a
      // storage nit, never something to surface to the user.
      if (liveMedia) {
        void deleteAccountMedia(convex, liveMedia.key).catch(() => {});
      }
    }
  };

  const sendText = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    await runTurn({ role: 'user', content: text }, null);
  };

  /** Track a local object URL so it can be revoked on reset/unmount. */
  const trackObjectUrl = (url: string) => {
    objectUrlsRef.current.push(url);
    return url;
  };

  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error('Image is too large (max 5 MB).');
      return;
    }
    const previewUrl = trackObjectUrl(URL.createObjectURL(file));
    setStagedImage({ file, previewUrl });
  };

  const sendStagedImage = async () => {
    if (!stagedImage || sending) return;
    const caption = input.trim();
    const { file, previewUrl } = stagedImage;
    setStagedImage(null);
    setInput('');
    setSending(true);
    let key: string;
    try {
      ({ key } = await uploadAccountMedia(convex, startUpload, file, 'inbound'));
    } catch {
      toast.error('Upload failed.');
      // Roll back so the user can retry — same contract as the text path,
      // which hands the typed message back on failure.
      setStagedImage({ file, previewUrl });
      setInput(caption);
      setSending(false);
      return;
    }
    const ok = await runTurn(
      { role: 'user', content: caption, media: { kind: 'image', previewUrl } },
      { kind: 'image', key },
    );
    if (!ok) {
      // Same contract as the upload-failure path above: hand the attachment
      // and caption back so the user can retry.
      setStagedImage({ file, previewUrl });
      setInput(caption);
    }
  };

  const pickAudioMime = (): MediaRecorderOptions | undefined => {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const mimeType of candidates) {
      if (
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported(mimeType)
      ) {
        return { mimeType };
      }
    }
    return undefined; // let the browser choose
  };

  const clearRecTimer = () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    recTimerRef.current = null;
  };

  const sendVoiceNote = async (blob: Blob) => {
    // The recorder's `onstop` can fire after unmount (stopRecording nulls the
    // ref before the event arrives, so the unmount cleanup can't neutralize
    // it). Bail before uploading/creating an object URL nothing can revoke.
    if (!isMountedRef.current) return;
    const type = blob.type || 'audio/webm';
    const ext = type.includes('mp4')
      ? 'm4a'
      : type.includes('ogg')
        ? 'ogg'
        : 'webm';
    const file = new File([blob], `voice-note.${ext}`, { type });
    const previewUrl = trackObjectUrl(URL.createObjectURL(blob));
    setSending(true);
    let key: string;
    try {
      ({ key } = await uploadAccountMedia(convex, startUpload, file, 'inbound'));
    } catch {
      toast.error('Upload failed.');
      setSending(false);
      return;
    }
    await runTurn(
      { role: 'user', content: '', media: { kind: 'audio', previewUrl } },
      { kind: 'audio', key },
    );
  };

  // Defined before `startRecording` so the interval callback inside it can
  // reference `stopRecording` without tripping no-use-before-define.
  const stopRecording = () => {
    clearRecTimer();
    setRecording(false);
    mediaRecorderRef.current?.stop(); // fires onstop → sends
    mediaRecorderRef.current = null;
  };

  const cancelRecording = () => {
    clearRecTimer();
    setRecording(false);
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder) {
      // Discard: drop chunks and stop tracks without sending.
      recChunksRef.current = [];
      recorder.onstop = () => recorder.stream.getTracks().forEach((tr) => tr.stop());
      recorder.stop();
    }
  };

  const startRecording = async () => {
    if (sending || recording || startingRecordingRef.current) return;
    startingRecordingRef.current = true;
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast.error('Microphone access was denied.');
        return;
      }
      // The permission prompt is non-blocking, so the component can unmount
      // while we're suspended on the await above (user taps the mic, then
      // navigates away before answering it). `mediaRecorderRef` is still
      // null at that point, so the unmount cleanup was a no-op and releasing
      // this stream falls to us: hand it back and stay out of the UI. Left
      // running, the mic would stay hot until the 60s cap fired
      // `stopRecording` and uploaded a voice note from a page the user had
      // already left. This is the only suspension point in `startRecording` —
      // everything below it is synchronous, so one check here is enough.
      if (!isMountedRef.current) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      recChunksRef.current = [];
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, pickAudioMime());
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) recChunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((tr) => tr.stop());
          const blob = new Blob(recChunksRef.current, { type: recorder.mimeType });
          recChunksRef.current = [];
          if (blob.size > 0) void sendVoiceNote(blob);
        };
        recorder.start();
      } catch {
        // Release the mic we already acquired — otherwise it stays hot with
        // no UI path to stop it.
        stream.getTracks().forEach((tr) => tr.stop());
        toast.error("Recording isn't supported in this browser.");
        return;
      }
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setRecSeconds(0);
      recTimerRef.current = setInterval(() => {
        setRecSeconds((s) => {
          if (s + 1 >= MAX_RECORDING_SECONDS) stopRecording();
          return s + 1;
        });
      }, 1000);
    } finally {
      startingRecordingRef.current = false;
    }
  };

  const handleSend = () => {
    if (stagedImage) void sendStagedImage();
    else void sendText();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const reset = () => {
    if (recording) cancelRecording();
    objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    objectUrlsRef.current = [];
    setTurns([]);
    setStagedImage(null);
  };

  return (
    <div className="flex h-[60vh] min-h-[420px] flex-col rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Playground</span>
          <span className="text-xs text-muted-foreground">
            — test replies as if you were a customer
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={(turns.length === 0 && !stagedImage) || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
            <p>Send a message to see how your agent would reply.</p>
            <p className="mt-1 text-xs">
              It uses your knowledge base and behaves exactly like the
              auto-reply bot — including handoff.
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                Not set up yet? Go to Setup <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((t, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2',
              t.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            {t.role === 'assistant' && (
              <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
            )}
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm',
                t.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm bg-muted text-foreground',
              )}
            >
              {/* Media preview (user turns) */}
              {t.media?.kind === 'image' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.media.previewUrl}
                  alt="Sent attachment"
                  className="mb-1.5 max-h-48 rounded-lg object-cover"
                />
              )}
              {t.media?.kind === 'audio' && (
                <>
                  <p className="mb-1 text-xs opacity-80">Voice note</p>
                  <audio
                    controls
                    src={t.media.previewUrl}
                    className="mb-1.5 w-56 max-w-full"
                  />
                </>
              )}
              {t.content && <p className="whitespace-pre-wrap">{t.content}</p>}

              {/* What the bot understood (user media turns) */}
              {t.media && (t.media.understanding || t.media.understoodFailed) && (
                <p
                  className={cn(
                    'mt-1.5 border-t pt-1.5 text-xs',
                    t.role === 'user'
                      ? 'border-primary-foreground/25 text-primary-foreground/80'
                      : 'border-border/50 text-muted-foreground',
                  )}
                >
                  {t.media.understanding
                    ? `${t.media.kind === 'audio' ? 'Heard' : 'Bot saw'}: ${t.media.understanding}`
                    : t.media.kind === 'audio'
                      ? "Couldn't transcribe this (needs an OpenAI key, or the audio was unclear)."
                      : "Couldn't read this image (needs an OpenAI key, or it wasn't readable)."}
                </p>
              )}

              {t.role === 'assistant' && t.handoff && (
                <p
                  className={cn(
                    'flex items-center gap-1 text-xs text-amber-500',
                    t.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                  )}
                >
                  <UserCircle2 className="h-3.5 w-3.5" />
                  Would hand off to a human here
                </p>
              )}
            </div>
            {t.role === 'user' && (
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-5 w-5 text-primary" />
            <Loader2 className="h-4 w-4 animate-spin" />
            {pendingKind === 'audio'
              ? 'Transcribing…'
              : pendingKind === 'image'
                ? 'Reading image…'
                : 'Thinking…'}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border p-3">
        {stagedImage && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={stagedImage.previewUrl}
              alt="Staged"
              className="h-12 w-12 rounded object-cover"
            />
            <span className="flex-1 text-xs text-muted-foreground">
              Image attached — add a caption (optional) and send.
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStagedImage(null)}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              title="Remove image"
              aria-label="Remove image"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickImage}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || !!stagedImage || recording}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground"
            title="Attach an image"
          >
            <ImageIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={recording ? stopRecording : startRecording}
            disabled={!recording && (sending || !!stagedImage)}
            className={cn(
              'h-9 w-9 shrink-0 p-0',
              recording ? 'text-red-500' : 'text-muted-foreground',
            )}
            title={recording ? 'Stop & send' : 'Record a voice note'}
          >
            {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          {recording ? (
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-red-500/40 bg-muted px-4 py-2.5 text-sm">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <span className="flex-1 text-foreground">
                Recording… {Math.floor(recSeconds / 60)}:
                {String(recSeconds % 60).padStart(2, '0')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelRecording}
                className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
                title="Discard"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={stagedImage ? 'Add a caption…' : 'Type a customer message…'}
              rows={1}
              className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
          )}
          <Button
            size="sm"
            onClick={handleSend}
            disabled={sending || recording || (!input.trim() && !stagedImage)}
            className="h-9 w-9 shrink-0 p-0"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
