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
const bandwidthSelector = document.querySelector('select#bandwidth');

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

function swapPayloadTypes(sdp, payloadType1, payloadType2) {
  return sdp
	// Swap first payload type with 255
	.replace('a=rtpmap:' + payloadType1 + ' ', 'a=rtpmap:255 ')
	.replace('a=rtcp-fb:' + payloadType1 + ' ', 'a=rtcp-fb:255 ')
	.replace('a=fmtp:' + payloadType1 + ' ' + payloadType2 + '/' + payloadType2, 'a=fmtp:255 255/255')
    .replace('a=fmtp:' + payloadType1 + ' minptime=10;useinbandfec=', 'a=fmtp:255 minptime=10;useinbandfec=')
	// swawp second payload type with first payload type
	.replace('a=rtpmap:' + payloadType2 + ' ', 'a=rtpmap:' + payloadType1 + ' ')
	.replace('a=rtcp-fb:' + payloadType2 + ' ', 'a=rtcp-fb:' + payloadType1 + ' ')
	.replace('a=fmtp:' + payloadType2 + ' ' + payloadType1 + '/' + payloadType1, 'a=fmtp:' + payloadType1 + ' ' + payloadType2 + '/' + payloadType2)
    .replace('a=fmtp:' + payloadType2 + ' minptime=10;useinbandfec=', 'a=fmtp:' + payloadType1 + ' minptime=10;useinbandfec=')
	// swap 255 with second payload type
	.replace('a=rtpmap:255 ', 'a=rtpmap:' + payloadType2 + ' ')
	.replace('a=rtcp-fb:255 ', 'a=rtcp-fb:' + payloadType2 + ' ')
	.replace('a=fmtp:255 255/255', 'a=fmtp:' + payloadType2 + ' ' + payloadType1 + '/' + payloadType1)
    .replace('a=fmtp:255 minptime=10;useinbandfec=', 'a=fmtp:' + payloadType2 + ' minptime=10;useinbandfec=');
}

async function call() {
  codecSelect.disabled = true;
  callButton.disabled = true;
  hangupButton.disabled = false;
  bandwidthSelector.disabled = false;

  initialTimestamp = 0;
  maxBitrate = 0;
  minBitrate = 1000000000;
  lastTimestamp = null;
  lastBytesSent = null;

  const useLyra = codecSelect.value === "lyra";
  pc1 = new RTCPeerConnection({ encodedInsertableStreams: true, bundlePolicy: 'max-bundle'});
  pc2 = new RTCPeerConnection({ encodedInsertableStreams: true });
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
        transform: receiveTransform
      });
      receiverStreams.readable
          .pipeThrough(transformStream)
          .pipeTo(receiverStreams.writable);
    }
    audioOutput.srcObject = e.streams[0];
  };
  const opus = pc1.addTransceiver(localStream.getTracks()[0], {streams: [localStream]}).sender;
  const opusStream = opus.createEncodedStreams();
  opusStream.readable
    .pipeThrough(new TransformStream({
      transform: replaceSilkInOpus,
    }))
    .pipeTo(opusStream.writable);
  const l16  = pc1.addTransceiver(localStream.getTracks()[0], {streams: [localStream]}).sender;
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
  
  const modifiedOffer = sections[0].replace('BUNDLE 0 1', 'BUNDLE 0') +
    swapPayloadTypes(
                     sections[1]
                        .replace('AVPF 111 ', 'AVPF 111 109 ')
                        .replace('useinbandfec=1', 'useinbandfec=0'), 111, 63);
  await pc2.setRemoteDescription({type: 'offer', sdp: modifiedOffer});  
  
  const answer = await pc2.createAnswer();
  answer.sdp = answer.sdp
      .replace('AVPF 111 ', 'AVPF 109 111 ') 
      .replace('useinbandfec=1', 'useinbandfec=0') +
    'a=rtpmap:109 L16/16000/1\r\n';
  await pc2.setLocalDescription(answer);
  
  sections = SDPUtils.splitSections(answer.sdp);
  const modifiedAnswer = sections[0].replace('BUNDLE 0', 'BUNDLE 0 1') +
    swapPayloadTypes(
					 sections[1].replace('AVPF 109 111 63', 'AVPF 111 63'), 63, 111) +
       'a=fmtp:111 ptime=20\r\n' +
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

let l16Buffer = [];
/*
The "cutoff mode" was chosen to be 3 but in practice you want it to be either
11 (assuming Lyra beats SILK in WB) or 7 (where Lyra will win clearly).
*/
const CUTOFF = 3;

function replaceSilkInOpus(encodedFrame, controller) {
  // Would be great to know the current target bitrate.
  const data = new Uint8Array(encodedFrame.data);
  /* https://www.rfc-editor.org/rfc/rfc6716#section-3.1
   +-----------------------+-----------+-----------+-------------------+
   | Configuration         | Mode      | Bandwidth | Frame Sizes       |
   | Number(s)             |           |           |                   |
   +-----------------------+-----------+-----------+-------------------+
   | 0...3                 | SILK-only | NB        | 10, 20, 40, 60 ms |
   | 4...7                 | SILK-only | MB        | 10, 20, 40, 60 ms |
   | 8...11                | SILK-only | WB        | 10, 20, 40, 60 ms |
   | 12...13               | Hybrid    | SWB       | 10, 20 ms         |
   | 14...15               | Hybrid    | FB        | 10, 20 ms         |
   ...
   In practice libwebrtc uses just a few of them. When setting the encoder
   bitrate to 6kbps you can see the config drop from 13/15 to 9, 5+6 and 1.
  */
  const configuration = data[0] >> 3;
  const l16 = l16Buffer.shift();
  // console.log('Configuration:', data[0] >> 3, !!l16);
  document.getElementById('configuration').innerText = 'Opus encoded as config: ' + configuration;
  if (configuration <= CUTOFF) {
    if (!l16) {
      console.log('l16 buffer empty');
      return;
    }
    // Actually we create a 20ms delay here. Need to do something smarter and put
    // L16 into the first m-line but then send from the second so that L16 is "encoded"
    // first and we can grab the packet. This is ok for the demo but needs some more
    // effort in practice
    // You can actually perceive the extra delay when the switch happens.
    // Encode L16 using Lyra.
    const inputDataArray = new Uint8Array(l16.data);

    const inputBufferPtr = codecModule._malloc(l16.data.byteLength);
    const encodedBufferPtr = codecModule._malloc(1024);

    codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
    const length = codecModule.encode(inputBufferPtr,
        inputDataArray.length, 16000,
        encodedBufferPtr);

    const newData = new Uint8Array(length + 1);
    // Copy the configuration.
    newData[0] = data[0];
    if (length > 0) {
      // but replace the SILK data,
      newData.set(codecModule.HEAPU8.subarray(encodedBufferPtr, encodedBufferPtr + length), 1);
    }
    encodedFrame.data = newData.buffer;

    codecModule._free(inputBufferPtr);
    codecModule._free(encodedBufferPtr);
    // TODO: drop length = 0 here?
  }

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

function receiveTransform(encodedFrame, controller) {
  if (encodedFrame.data.byteLength === 0) {
    controller.enqueue(encodedFrame);
    return;
  }
  const originalData = new Uint8Array(encodedFrame.data);
  const configuration = originalData[0] >> 3;
  // We make the input red as PT.
  let newData;
  if (configuration <= CUTOFF) {
    // Decode as Lyra.
    if (encodedFrame.data.byteLength === 1) {
      // no data, essentially DTX. TODO: replace with opus dtx or empty call?
      return;
    }
    const inputDataArray = new Uint8Array(encodedFrame.data).slice(1);
    const inputBufferPtr = codecModule._malloc(encodedFrame.data.byteLength - 1);
    const outputBufferPtr = codecModule._malloc(16384);
    codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
    const length = codecModule.decode(inputBufferPtr,
        inputDataArray.length, 16000,
        outputBufferPtr);
  
    newData = new Uint8Array(length + 1);
    newData[0] = 109; // set RED header to L16.
    newData.set(codecModule.HEAPU8.subarray(outputBufferPtr, outputBufferPtr + length), 1);
  
    codecModule._free(inputBufferPtr);
    codecModule._free(outputBufferPtr);
  } else {
    newData = new Uint8Array(encodedFrame.data.byteLength + 1);
    newData[0] = 63; // set RED header to opus.
    newData.set(new Uint8Array(encodedFrame.data), 1);
  }

  encodedFrame.data = newData.buffer;
  controller.enqueue(encodedFrame);
}

function updateStat() {
  let mediaSourceId;
  pc1.getStats().then((stats) => {
    stats.forEach((stat) => {
      if (stat.type === "outbound-rtp" && stat.mid === "0") {
        const timestamp = stat.timestamp;
        const bytesSent = stat.bytesSent;
        if (lastTimestamp && lastBytesSent) {
          const bitrate = (bytesSent - lastBytesSent) * 8 / ((timestamp - lastTimestamp) / 1000.0);
          console.log('BR', bitrate, bytesSent, lastBytesSent);
          if (bitrate < minBitrate) {
            minBitrate = bitrate;
          }
          if (bitrate > maxBitrate) {
            maxBitrate = bitrate;
          }
          bitrateSpan.innerText =
              `bitrate: ${(bitrate / 1000).toFixed()} kbit/s` +
              `target: ${stat.targetBitrate} kbit/s`;
        }
        if (initialTimestamp === 0) {
          initialTimestamp = timestamp;
        }
        lastTimestamp = timestamp;
        lastBytesSent = bytesSent;
      }
    });
  });
  pc2.getStats().then(stats => {
    stats.forEach((stat) => {
      if (stat.type === 'inbound-rtp') {
        document.getElementById('codec').innerText = 'Decoded as ' + stats.get(stat.codecId).mimeType;
      }
    });
  });
}

bandwidthSelector.onchange = async () => {
  bandwidthSelector.disabled = true;
  const bandwidth = bandwidthSelector.options[bandwidthSelector.selectedIndex].value;

  const sender = pc1.getSenders()[0];
  const parameters = sender.getParameters();
  if (bandwidth === 'unlimited') {
    delete parameters.encodings[0].maxBitrate;
  } else {
    parameters.encodings[0].maxBitrate = bandwidth;
  }
  await sender.setParameters(parameters)
  bandwidthSelector.disabled = false;
}
