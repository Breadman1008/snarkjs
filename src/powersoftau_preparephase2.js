const binFileUtils = require("./binfileutils");
const utils = require("./powersoftau_utils");
const fastFile = require("fastfile");
const {bitReverse} = require("./misc");
const fs = require("fs");

async function preparePhase2(oldPtauFilename, newPTauFilename, verbose) {

    const {fd: fdOld, sections} = await binFileUtils.readBinFile(oldPtauFilename, "ptau", 1);
    const {curve, power} = await utils.readPTauHeader(fdOld, sections);

    const fdNew = await binFileUtils.createBinFile(newPTauFilename, "ptau", 1, 11);
    await utils.writePTauHeader(fdNew, curve, power);

    const fdTmp = await fastFile.createOverride(newPTauFilename+ ".tmp");

    await binFileUtils.copySection(fdOld, sections, fdNew, 2);
    await binFileUtils.copySection(fdOld, sections, fdNew, 3);
    await binFileUtils.copySection(fdOld, sections, fdNew, 4);
    await binFileUtils.copySection(fdOld, sections, fdNew, 5);
    await binFileUtils.copySection(fdOld, sections, fdNew, 6);
    await binFileUtils.copySection(fdOld, sections, fdNew, 7);

    await processSection(2, 12, "G1", "tauG1" );
    await processSection(3, 13, "G2", "tauG2" );
    await processSection(4, 14, "G1", "alphaTauG1" );
    await processSection(5, 15, "G1", "betaTauG1" );

    await fdOld.close();
    await fdNew.close();
    await fdTmp.close();

    await fs.promises.unlink(newPTauFilename+ ".tmp");

    return;

    async function processSection(oldSectionId, newSectionId, Gstr, sectionName) {
        const CHUNKPOW = 16;
        if (verbose) console.log("Starting section: "+sectionName);

        await binFileUtils.startWriteSection(fdNew, newSectionId);

        for (let p=0; p<=power; p++) {
            await processSectionPower(p);
        }

        await binFileUtils.endWriteSection(fdNew);

        async function processSectionPower(p) {
            const chunkPower = p > CHUNKPOW ? CHUNKPOW : p;
            const pointsPerChunk = 1<<chunkPower;
            const nPoints = 1 << p;
            const nChunks = nPoints / pointsPerChunk;

            const G = curve[Gstr];
            const Fr = curve.Fr;
            const PFr = curve.PFr;
            const sGin = G.F.n8*2;
            const sGmid = G.F.n8*3;

            await binFileUtils.startReadUniqueSection(fdOld, sections, oldSectionId);
            // Build the initial tmp Buff
            fdTmp.pos =0;
            for (let i=0; i<nChunks; i++) {
                let buff;
                if (verbose) console.log(`${sectionName} Prepare ${i+1}/${nChunks}`);
                buff = await fdOld.read(pointsPerChunk*sGin);
                buff = await G.batchToJacobian(buff);
                for (let j=0; j<pointsPerChunk; j++) {
                    fdTmp.pos = bitReverse(i*pointsPerChunk+j, p)*sGmid;
                    await fdTmp.write(buff.slice(j*sGmid, (j+1)*sGmid ));
                }
            }
            await binFileUtils.endReadSection(fdOld, true);

            for (let i=1; i<= p; i++) {
                if (i<=chunkPower) {
                    for (let j=0; j<nChunks; j++) {
                        if (verbose) console.log(`${sectionName} ${i}/${p} FFTMix ${j+1}/${nChunks}`);
                        let buff;
                        fdTmp.pos = (j*pointsPerChunk)*sGmid;
                        buff = await fdTmp.read(pointsPerChunk*sGmid);
                        buff = await G.fftMix(buff, i);
                        fdTmp.pos = (j*pointsPerChunk)*sGmid;
                        await fdTmp.write(buff);
                    }
                } else {
                    const nGroups = 1 << (p - i);
                    const nChunksPerGroup = nChunks / nGroups;
                    for (let j=0; j<nGroups; j++) {
                        for (let k=0; k <nChunksPerGroup/2; k++) {
                            if (verbose) console.log(`${sectionName} ${i}/${p} FFTJoin ${j+1}/${nGroups} ${k}/${nChunksPerGroup/2}`);
                            const first = Fr.pow( PFr.w[i], k*pointsPerChunk);
                            const inc = PFr.w[i];
                            const o1 = j*nChunksPerGroup + k;
                            const o2 = j*nChunksPerGroup + k + nChunksPerGroup/2;

                            let buff1, buff2;
                            fdTmp.pos = o1*sGmid;
                            buff1 = await fdTmp.read(pointsPerChunk * sGmid);
                            fdTmp.pos = o2*sGmid;
                            buff2 = await fdTmp.read(pointsPerChunk * sGmid);

                            [buff1, buff2] = await G.fftJoin(buff1, buff2, first, inc);

                            fdTmp.pos = o1*sGmid;
                            await fdTmp.write(buff1);
                            fdTmp.pos = o2*sGmid;
                            await fdTmp.write(buff2);
                        }
                    }
                }
            }
            await finalInverse(p);
        }
        async function finalInverse(p) {
            const G = curve[Gstr];
            const Fr = curve.Fr;
            const sGmid = G.F.n8*3;
            const sGout = G.F.n8*2;

            const chunkPower = p > CHUNKPOW ? CHUNKPOW : p;
            const pointsPerChunk = 1<<chunkPower;
            const nPoints = 1 << p;
            const nChunks = nPoints / pointsPerChunk;

            const o = fdNew.pos;
            fdTmp.pos = 0;
            for (let i=0; i<nChunks; i++) {
                if (verbose) console.log(`${sectionName} ${p} FFTFinal ${i+1}/${nChunks}`);
                let buff;
                buff = await fdTmp.read(pointsPerChunk * sGmid);
                buff = await G.fftFinal(buff, Fr.inv( Fr.e( 1<< p)));

                if ( i == 0) {
                    fdNew.pos = o;
                    await fdNew.write(buff.slice((pointsPerChunk-1)*sGout));
                    fdNew.pos = o + ((nChunks - 1)*pointsPerChunk + 1) * sGout;
                    await fdNew.write(buff.slice(0, (pointsPerChunk-1)*sGout));
                } else {
                    fdNew.pos = o + ((nChunks - 1 - i)*pointsPerChunk + 1) * sGout;
                    await fdNew.write(buff);
                }
            }
            fdNew.pos = o + nChunks * pointsPerChunk * sGout;
        }
    }
}

module.exports = preparePhase2;