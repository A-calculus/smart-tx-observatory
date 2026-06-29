import { Connection } from '@solana/web3.js';

async function testLeader() {
    const conn = new Connection('https://fra.rpc.solinfra.dev/sol?api_key=DyTGiD8IGqKG9S3n', 'confirmed');
    try {
        const epochInfo = await conn.getEpochInfo();
        console.log('Epoch Info:', epochInfo);

        const slot = await conn.getSlot();
        const leaders = await conn.getSlotLeaders(slot, 10);
        console.log('Current slot leaders (via getSlotLeaders):', leaders.map(l => l.toBase58()));

        const schedule = await conn.getLeaderSchedule();
        if (schedule) {
            const pks = Object.keys(schedule);
            console.log(`Leader schedule has ${pks.length} validators.`);
        } else {
            console.log('Leader schedule is null.');
        }
    } catch (e) {
        console.error(e);
    }
}
testLeader();
