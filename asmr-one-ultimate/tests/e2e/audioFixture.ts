export function createSilentWav(sampleRate = 16000, durationSeconds = 1): Buffer {
    const channels = 1;
    const bitsPerSample = 16;
    const dataSize = sampleRate * durationSeconds * channels * (bitsPerSample / 8);
    const wav = Buffer.alloc(44 + dataSize);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(channels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    wav.writeUInt16LE(bitsPerSample, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataSize, 40);
    return wav;
}
