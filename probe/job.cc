#include <node_api.h>
#include <windows.h>
#include <stdio.h>

// Proof only: one non-inheritable handle owned by this process until OS exit.
static HANDLE job = NULL;
static napi_value fail(napi_env env, const char* operation) {
  char message[160];
  snprintf(message, sizeof(message), "%s failed: Windows error %lu", operation, GetLastError());
  napi_throw_error(env, NULL, message);
  return NULL;
}
static napi_value join(napi_env env, napi_callback_info info) {
  if (!job) {
    HANDLE candidate = CreateJobObjectW(NULL, NULL);
    if (!candidate) return fail(env, "CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(candidate, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
      DWORD error = GetLastError(); CloseHandle(candidate); SetLastError(error);
      return fail(env, "SetInformationJobObject");
    }
    // Assignment precedes all descendants. No spawn-then-attach race.
    if (!AssignProcessToJobObject(candidate, GetCurrentProcess())) {
      DWORD error = GetLastError(); CloseHandle(candidate); SetLastError(error);
      return fail(env, "AssignProcessToJobObject");
    }
    job = candidate;
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value exited(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  uint32_t pid = 0, timeout = 0;
  napi_get_value_uint32(env, args[0], &pid);
  napi_get_value_uint32(env, args[1], &timeout);
  HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
  bool gone;
  if (!process) {
    if (GetLastError() != ERROR_INVALID_PARAMETER) return fail(env, "OpenProcess");
    gone = true;
  } else {
    DWORD result = WaitForSingleObject(process, timeout);
    CloseHandle(process);
    if (result == WAIT_FAILED) return fail(env, "WaitForSingleObject");
    gone = result == WAIT_OBJECT_0;
  }
  napi_value result; napi_get_boolean(env, gone, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value value;
  napi_create_function(env, "join", NAPI_AUTO_LENGTH, join, NULL, &value);
  napi_set_named_property(env, exports, "join", value);
  napi_create_function(env, "exited", NAPI_AUTO_LENGTH, exited, NULL, &value);
  napi_set_named_property(env, exports, "exited", value);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
