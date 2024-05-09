#!/usr/bin/bash
svn export https://github.com/quickfix/quickfix/trunk/test/definitions qfixtests
# Since this command doesn't seem to work anymore, do this:
# 1. git clone --single-branch https://github.com/quickfix/quickfix.git
# 2. cp -r quickfix/test/definitions/ qfixtests
