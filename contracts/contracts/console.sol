// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract Console {
  event LogString(string, string);
  function log(string  memory s , string memory x) public {
    emit LogString(s, x);
  }

  event LogUint(string, uint);
  function log(string  memory s , uint  x) public {
    emit LogUint(s, x);
  }

  event LogInt(string, int);
  function log(string  memory s , int  x) public  {
    emit LogInt(s, x);
  }
  
  event LogBytes(string, bytes);
  function log(string  memory s , bytes  memory x) public  {
    emit LogBytes(s, x);
  }
  
  event LogBytes32(string, bytes32);
  function log(string  memory s , bytes32  x)  public {
    emit LogBytes32(s, x);
  }

  event LogAddress(string, address);
  function log(string  memory s , address  x) public  {
    emit LogAddress(s, x);
  }

  event LogBool(string, bool);
  function log(string  memory s , bool  x)  public {
    emit LogBool(s, x);
  }








}