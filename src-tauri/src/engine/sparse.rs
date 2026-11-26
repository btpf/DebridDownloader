//! Sparse `.part` files.
//!
//! A download writes up to four segments at different offsets. On NTFS a write past the file's
//! valid-data length makes Windows zero-fill the gap first, synchronously, inside that write: for
//! a 200 GB file on a slow drive that is tens of minutes no cancel can interrupt. Marking the file
//! sparse first lets unwritten ranges stay holes. Linux and macOS already leave holes on `set_len`.
use std::io;

/// Mark `file` sparse. A no-op off Windows.
#[cfg(windows)]
pub fn mark_sparse<F: std::os::windows::io::AsRawHandle>(file: &F) -> io::Result<()> {
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;
    use windows_sys::Win32::System::IO::DeviceIoControl;
    let mut returned = 0u32;
    // SAFETY: the handle is owned by `file` and stays open for the call; no buffers are passed.
    let ok = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn mark_sparse<F>(_file: &F) -> io::Result<()> {
    Ok(())
}
