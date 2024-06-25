pragma solidity ^0.5.16;

interface IRwaoneEscrow {
    function numVestingEntries(address account) external view returns (uint);

    function getVestingScheduleEntry(address account, uint index) external view returns (uint[2] memory);
}

// https://docs.rwaone.io/contracts/source/contracts/escrowchecker
contract EscrowChecker {
    IRwaoneEscrow public rwaone_escrow;

    constructor(IRwaoneEscrow _esc) public {
        rwaone_escrow = _esc;
    }

    function checkAccountSchedule(address account) public view returns (uint[16] memory) {
        uint[16] memory _result;
        uint schedules = rwaone_escrow.numVestingEntries(account);
        for (uint i = 0; i < schedules; i++) {
            uint[2] memory pair = rwaone_escrow.getVestingScheduleEntry(account, i);
            _result[i * 2] = pair[0];
            _result[i * 2 + 1] = pair[1];
        }
        return _result;
    }
}
