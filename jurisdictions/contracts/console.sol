// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract Console {
  bool internal constant DEBUG_CONSOLE = false;
  event LogString(string, string);
  function log(string  memory s , string memory x) internal {
    if (!DEBUG_CONSOLE) return;
    emit LogString(s, x);
  }

  event LogUint(string, uint);
  function log(string  memory s , uint  x) internal {
    if (!DEBUG_CONSOLE) return;
    emit LogUint(s, x);
  }

  event LogInt(string, int);
  function log(string  memory s , int  x) internal  {
    if (!DEBUG_CONSOLE) return;
    emit LogInt(s, x);
  }
  
  event LogBytes(string, bytes);
  function log(string  memory s , bytes  memory x) internal  {
    if (!DEBUG_CONSOLE) return;
    emit LogBytes(s, x);
  }
  
  event LogBytes32(string, bytes32);
  function log(string  memory s , bytes32  x)  internal {
    if (!DEBUG_CONSOLE) return;
    emit LogBytes32(s, x);
  }

  event LogAddress(string, address);
  function log(string  memory s , address  x) internal  {
    if (!DEBUG_CONSOLE) return;
    emit LogAddress(s, x);
  }

  event LogBool(string, bool);
  function log(string  memory s , bool  x)  internal {
    if (!DEBUG_CONSOLE) return;
    emit LogBool(s, x);
  }








}
