import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Sheet } from './Sheet';

type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>> };
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

const getBarcodeDetector = (): BarcodeDetectorCtor | null =>
	(window as typeof window & { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;

/** Read a QR out of an image file, the same two-step detection the camera uses. */
async function decodeImageFile(file: File): Promise<string | null> {
	const bitmap = await createImageBitmap(file);
	try {
		const Detector = getBarcodeDetector();
		if (Detector) {
			const results = await new Detector({ formats: ['qr_code'] }).detect(bitmap);
			const raw = String(results[0]?.rawValue || '').trim();
			if (raw) return raw;
		}
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) return null;
		context.drawImage(bitmap, 0, 0);
		const image = context.getImageData(0, 0, canvas.width, canvas.height);
		return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data?.trim() || null;
	} finally {
		bitmap.close();
	}
}

/**
 * Camera QR scanner for invoices. Native BarcodeDetector where the platform has
 * one, jsQR over canvas frames otherwise. Same two-step detection the SvelteKit
 * PaymentPanel uses.
 *
 * A desktop without a camera, or a person who declined it, still has to be able
 * to pay: the picture of the invoice is the second way in, as it is in the
 * SvelteKit panel.
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
					.catch(error => {
                        if (stopped) return;
                        stopped = true;
                        stream?.getTracks().forEach(track => track.stop());
                        setError(error instanceof Error ? error.message : String(error));
                    });
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
			{error ? (
				<p style={{ color: 'var(--dispute)', fontSize: 13 }}>The camera is unavailable: {error}</p>
			) : null}
			<label className="btn quiet sm" style={{ marginTop: 8, display: 'inline-block', cursor: 'pointer' }} data-testid="scan-upload">
				Use a picture of the invoice
				<input
					type="file"
					accept="image/*"
					style={{ display: 'none' }}
					onChange={event => {
						const file = event.target.files?.[0];
						event.target.value = '';
						if (!file) return;
						setError(null);
						setStatus('Reading the picture…');
						void decodeImageFile(file)
							.then(value => {
								if (value) {
									onDecode(value);
									return;
								}
								setStatus('');
								setError('No xln invoice found in that picture.');
							})
							.catch(readError => {
								setStatus('');
								setError(readError instanceof Error ? readError.message : String(readError));
							});
					}}
				/>
			</label>
		</Sheet>
	);
}
