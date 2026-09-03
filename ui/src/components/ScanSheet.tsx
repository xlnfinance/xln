import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Sheet } from './Sheet';

type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>> };
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

const getBarcodeDetector = (): BarcodeDetectorCtor | null =>
	(window as typeof window & { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;

/**
 * Camera QR scanner for invoices. Native BarcodeDetector where the platform has
 * one, jsQR over canvas frames otherwise. Same two-step detection the SvelteKit
 * PaymentPanel uses.
 */
export function ScanSheet({ onDecode, onClose }: { onDecode: (value: string) => void; onClose: () => void }) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [status, setStatus] = useState('Starting camera…');
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stream: MediaStream | null = null;
		let frame = 0;
		let stopped = false;
		const canvas = document.createElement('canvas');
		const context = canvas.getContext('2d', { willReadFrequently: true });

		const detect = async (video: HTMLVideoElement): Promise<string | null> => {
			const Detector = getBarcodeDetector();
			if (Detector) {
				const results = await new Detector({ formats: ['qr_code'] }).detect(video);
				const raw = String(results[0]?.rawValue || '').trim();
				if (raw) return raw;
			}
			if (!context || video.videoWidth === 0) return null;
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			const image = context.getImageData(0, 0, canvas.width, canvas.height);
			const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
			return code?.data?.trim() || null;
		};

		const loop = (): void => {
			if (stopped) return;
			frame = requestAnimationFrame(() => {
				const video = videoRef.current;
				if (!video || video.readyState < 2) {
					loop();
					return;
				}
				void detect(video)
					.then(value => {
						if (stopped) return;
						if (value) {
							stopped = true;
							onDecode(value);
							return;
						}
						loop();
					})
					.catch(() => loop());
			});
		};

		void (async () => {
			try {
				stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
				if (stopped) return;
				const video = videoRef.current;
				if (video) {
					video.srcObject = stream;
					await video.play();
				}
				setStatus('Point the camera at an xln invoice');
				loop();
			} catch (cameraError) {
				setError(cameraError instanceof Error ? cameraError.message : String(cameraError));
				setStatus('');
			}
		})();

		return () => {
			stopped = true;
			if (frame) cancelAnimationFrame(frame);
			for (const track of stream?.getTracks() ?? []) track.stop();
			const video = videoRef.current;
			if (video) {
				video.pause();
				video.srcObject = null;
			}
		};
	}, [onDecode]);

	return (
		<Sheet title="Scan invoice" onClose={onClose}>
			<div className="scanner">
				<video ref={videoRef} muted playsInline />
			</div>
			{status ? <p className="note">{status}</p> : null}
			{error ? <p style={{ color: 'var(--dispute)', fontSize: 13 }}>{error}</p> : null}
		</Sheet>
	);
}
