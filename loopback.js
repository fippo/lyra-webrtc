'use strict';

import Module from './webassembly_codec_wrapper.js';

let codecModule;
Module().then((module) => {
  console.log("Initialized codec's wasmModule.");
  codecModule = module;
}).catch(e => {
  console.log(`Module() error: ${e.name} message: ${e.message}`);
});

const startButton = document.getElementById('startButton');
const codecSelect = document.getElementById('codecSelect');
const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
const audioOutput = document.getElementById('audioOutput');
const bitrateSpan = document.getElementById('bitrateSpan');
const historyTBody = document.getElementById('historyTBody');

startButton.onclick = start;
callButton.onclick = call;
hangupButton.onclick = hangup;

let localStream;
let pc1;
let pc2;

let historyIndex = 0;
let initialTimestamp;
let maxBitrate;
let minBitrate;
let lastTimestamp;
let lastBytesSent;
let interval;

async function start() {
  startButton.disabled = true;
  localStream = await navigator.mediaDevices.getUserMedia({audio: true});
  callButton.disabled = false;
}

async function call() {
  codecSelect.disabled = true;
  callButton.disabled = true;
  hangupButton.disabled = false;

  initialTimestamp = 0;
  maxBitrate = 0;
  minBitrate = 1000000000;
  lastTimestamp = null;
  lastBytesSent = null;

  const useLyra = codecSelect.value === "lyra";
  pc1 = new RTCPeerConnection({ encodedInsertableStreams: true, bundlePolicy: 'max-bundle'});
  pc2 = new RTCPeerConnection({ encodedInsertableStreams: true});
  pc1.onicecandidate = (e) => {
    pc2.addIceCandidate(e.candidate)
  };
  pc2.onicecandidate = (e) => {
    pc1.addIceCandidate(e.candidate)
  };
  pc2.ontrack = (e) => {
    if (audioOutput.srcObject === e.streams[0]) {
      return;
    }
    if (useLyra) {
      const receiver = e.receiver;
      const receiverStreams = receiver.createEncodedStreams();
      const transformStream = new TransformStream({
        transform: receiveRedundancy,
      });
      receiverStreams.readable
          .pipeThrough(transformStream)
          .pipeTo(receiverStreams.writable);
    }
    audioOutput.srcObject = e.streams[0];
  };
  const opus = pc1.addTransceiver(localStream.getTracks()[0], localStream).sender;
  const opusStream = opus.createEncodedStreams();
  opusStream.readable
    .pipeThrough(new TransformStream({
      transform: addRedundancyToOpus,
    }))
    .pipeTo(opusStream.writable);
  const l16  = pc1.addTransceiver(localStream.getTracks()[0], localStream).sender;
  const l16Stream = l16.createEncodedStreams();
  l16Stream.readable
    .pipeThrough(new TransformStream({
      transform: grabL16Packet,
    }))
    .pipeTo(l16Stream.writable);

  const offer = await pc1.createOffer();
  let sections = SDPUtils.splitSections(offer.sdp);
  offer.sdp = sections[0] + sections[1] + 
    sections[2].replace('AVPF 111 ', 'AVPF 111 109 ') + 
    'a=rtpmap:109 L16/16000/1\r\n';
  await pc1.setLocalDescription(offer);
  
  const modifiedOffer = sections[0].replace('BUNDLE 0 1', 'BUNDLE 0')
    + sections[1].replace('AVPF 111 ', 'AVPF 111 109 ');
  await pc2.setRemoteDescription({type: 'offer', sdp: modifiedOffer});  
  
  const answer = await pc2.createAnswer();
  answer.sdp = answer.sdp.replace('AVPF 111 ', 'AVPF 109 111 ') + 
    'a=rtpmap:109 L16/16000/1\r\n';
  await pc2.setLocalDescription(answer);
  
  sections = SDPUtils.splitSections(answer.sdp);
  const modifiedAnswer = sections[0].replace('BUNDLE 0', 'BUNDLE 0 1') +
  	sections[1].replace('AVPF 109 111 63 ', 'AVPF 63 111 ') +
    sections[1]
      .replace('a=mid:0\r\n', 'a=mid:1\r\n') +
    	'a=fmtp:109 ptime=20\r\n';
  await pc1.setRemoteDescription({type: 'answer', sdp: modifiedAnswer});
  interval = setInterval(updateStat, 1000);
}

async function hangup() {
  clearInterval(interval);
  pc1.close();
  pc2.close();
  pc1 = null;
  pc2 = null;

  bitrateSpan.innerText = "";

  const time = (lastTimestamp - initialTimestamp) / 1000.0;
  if (time > 3) {
    const tr = document.createElement("tr");
    appendTD(tr, historyIndex++);
    appendTD(tr, codecSelect.options[codecSelect.selectedIndex].text);
    appendTD(tr, (maxBitrate / 1000).toFixed());
    appendTD(tr, (minBitrate / 1000).toFixed());
    const average = lastBytesSent * 8 / time;
    appendTD(tr, (average / 1000).toFixed());
    appendTD(tr, time.toFixed());
    historyTBody.appendChild(tr);
  }

  hangupButton.disabled = true;
  callButton.disabled = false;
  codecSelect.disabled = false;
}

function appendTD(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

function encodeFunction(encodedFrame, controller) {
  const inputDataArray = new Uint8Array(encodedFrame.data);

  const inputBufferPtr = codecModule._malloc(encodedFrame.data.byteLength);
  const encodedBufferPtr = codecModule._malloc(1024);

  codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
  const length = codecModule.encode(inputBufferPtr,
      inputDataArray.length, 16000,
      encodedBufferPtr);

  const newData = new ArrayBuffer(length);
  if (length > 0) {
    const newDataArray = new Uint8Array(newData);
    newDataArray.set(codecModule.HEAPU8.subarray(encodedBufferPtr, encodedBufferPtr + length));
  }

  codecModule._free(inputBufferPtr);
  codecModule._free(encodedBufferPtr);

  encodedFrame.data = newData;
  controller.enqueue(encodedFrame);
}

const l16Buffer = []; // TODO: prefill with [undefined] to shift 1 frame?
const MAX_TIMESTAMP = 0x100000000;
const payloadType = 63;
function addRedundancyToOpus(encodedFrame, controller) {
  const red = l16Buffer.shift();
  if (red) {
    //Encode L16 using Lyra.
    const inputDataArray = new Uint8Array(red.data);

    const inputBufferPtr = codecModule._malloc(red.data.byteLength);
    const encodedBufferPtr = codecModule._malloc(1024);

    codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
    const length = codecModule.encode(inputBufferPtr,
        inputDataArray.length, 16000,
        encodedBufferPtr);

    const newData = new ArrayBuffer(length);
    if (length > 0) {
      const newDataArray = new Uint8Array(newData);
      newDataArray.set(codecModule.HEAPU8.subarray(encodedBufferPtr, encodedBufferPtr + length));
    }

    codecModule._free(inputBufferPtr);
    codecModule._free(encodedBufferPtr);
    red.data = newData;
  }
  const allFrames = [red].filter(frame => !!frame).concat({
    timestamp: encodedFrame.timestamp,
    data: encodedFrame.data,
  });

  let needLength = 1 + encodedFrame.data.byteLength;
  for (let i = allFrames.length - 2; i >= 0; i--) {
     const frame = allFrames[i];
     needLength += 4 + frame.data.byteLength;
  }
  const newData = new Uint8Array(needLength);
  const newView = new DataView(newData.buffer);
  
  // Construct the header.
  let frameOffset = 0;
  //console.log('needLength', needLength);
  for (let i = 0; i < allFrames.length - 1; i++) {
    const frame = allFrames[i];
    // TODO: check this for wraparound
    const tOffset = (encodedFrame.timestamp - frame.timestamp + MAX_TIMESTAMP) % MAX_TIMESTAMP; // Ensure correct behaviour on wraparound.
    newView.setUint8(frameOffset, 109 | 0x80);
    newView.setUint16(frameOffset + 1, (tOffset << 2) ^ (frame.data.byteLength >> 8));
    newView.setUint8(frameOffset + 3, frame.data.byteLength & 0xff);
    frameOffset += 4;
  }
  // Last block header.
  newView.setUint8(frameOffset++, 111);

  // Construct the frame.
  for (let i = 0; i < allFrames.length; i++) {
     const frame = allFrames[i];
     newData.set(frame.data, frameOffset);
     frameOffset += frame.data.byteLength;
  }
  encodedFrame.data = newData.buffer;
  controller.enqueue(encodedFrame);  
}

function grabL16Packet(encodedFrame, controller) {
  l16Buffer.push({
    timestamp: encodedFrame.timestamp,
    data: new Uint8Array(encodedFrame.data).slice(0).buffer,
  });
  // clear and enqueue with 0 length.
  encodedFrame.data = (new Uint8Array(0)).buffer;
  controller.enqueue(encodedFrame);
}


function decodeFunction(encodedFrame, controller) {
  const newData = new ArrayBuffer(16000 * 0.02 * 2);
  if (encodedFrame.data.byteLength > 0) {
    const inputDataArray = new Uint8Array(encodedFrame.data);
    const inputBufferPtr = codecModule._malloc(encodedFrame.data.byteLength);
    const outputBufferPtr = codecModule._malloc(2048);
    codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
    const length = codecModule.decode(inputBufferPtr,
        inputDataArray.length, 16000,
        outputBufferPtr);
  
    const newDataArray = new Uint8Array(newData);
    newDataArray.set(codecModule.HEAPU8.subarray(outputBufferPtr, outputBufferPtr + length));
  
    codecModule._free(inputBufferPtr);
    codecModule._free(outputBufferPtr);
  }

  encodedFrame.data = newData;
  controller.enqueue(encodedFrame);
}

let dump = 10;
function receiveRedundancy(encodedFrame, controller) {
  if (encodedFrame.data.byteLength === 0) {
    controller.enqueue(encodedFrame);
    return;
  }
  const view = new DataView(encodedFrame.data);
  const data = new Uint8Array(encodedFrame.data);
  let headerLength = 0;
  let totalLength = 0;
  let redundancy = 0;
  let lengths = [];
  let payloadTypes = [];
  while (headerLength < encodedFrame.data.byteLength) {
    const nextBlock = view.getUint8(headerLength) & 0x80;
    if (!nextBlock) {
      payloadTypes.push(view.getUint8(headerLength));
      headerLength += 1;
      break;
    }
    redundancy++;
    const blockPayloadType = view.getUint8(headerLength) & 0x7f;
    payloadTypes.push(blockPayloadType);
    const tsOffset = view.getUint16(headerLength + 1) >> 2;
    const length = view.getUint16(headerLength + 2) & 0x3ff;
    lengths.push(length);
    totalLength += length;
    headerLength += 4;
  }
  if (headerLength + totalLength > encodedFrame.data.byteLength) { // Not RED.
    return controller.enqueue(encodedFrame);
  }
  const frames = [];
  let frameOffset = headerLength;
  while(lengths.length) {
    const length = lengths.shift();
    const frame = data.slice(frameOffset, frameOffset + length);
    frames.push(frame);
    frameOffset += length;
  }
  const newFrame = data.slice(frameOffset);
  frames.push(newFrame);
  
  //console.log('pre lyra decode', frames, payloadTypes);
  frames.forEach((frame, index) => {
    const blockPayloadType = payloadTypes[index];
    if (blockPayloadType !== 109) {
      return;
    }
    if (frame.byteLength === 0) {
      return;
    }
    const newData = new ArrayBuffer(16000 * 0.02 * 2);
    const inputDataArray = new Uint8Array(frame);
    const inputBufferPtr = codecModule._malloc(frame.byteLength);
    const outputBufferPtr = codecModule._malloc(2048);
    codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
    const length = codecModule.decode(inputBufferPtr,
                                      inputDataArray.length, 16000,
                                      outputBufferPtr);

    const newDataArray = new Uint8Array(newData);
    newDataArray.set(codecModule.HEAPU8.subarray(outputBufferPtr, outputBufferPtr + length));

    codecModule._free(inputBufferPtr);
    codecModule._free(outputBufferPtr);
    frames[index] = newDataArray;
  });
  if (frames[0].byteLength > 0 && dump > 0) {
      dump--;
      console.log('past lyra decode', frames, payloadTypes);
  }
}

function updateStat() {
  let mediaSourceId;
  pc1.getStats().then((stats) => {
    stats.forEach((stat) => {
      if (stat.type === "track") {
        mediaSourceId = stat.mediaSourceId;
      } else if (stat.type === "outbound-rtp" && stat.mediaSourceId === mediaSourceId) {
        const timestamp = stat.timestamp;
        const bytesSent = stat.bytesSent;
        if (lastTimestamp && lastBytesSent) {
          const bitrate = (bytesSent - lastBytesSent) * 8 / ((timestamp - lastTimestamp) / 1000.0);
          if (bitrate < minBitrate) {
            minBitrate = bitrate;
          }
          if (bitrate > maxBitrate) {
            maxBitrate = bitrate;
          }
          bitrateSpan.innerText =
              `time: ${((timestamp - initialTimestamp) / 1000.0).toFixed()} s ` +
              `bitrate: ${(bitrate / 1000).toFixed()} kbit/s`;
        }
        if (initialTimestamp === 0) {
          initialTimestamp = timestamp;
        }
        lastTimestamp = timestamp;
        lastBytesSent = bytesSent;
      }
    });
  });
}
